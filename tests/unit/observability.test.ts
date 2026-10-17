import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { braintrust, connectedBackends, dottedOrder, langfuse, langsmith, uuidFrom } from "../../src/observability/backends.ts";
import { buildDataset } from "../../src/observability/datasets.ts";
import type { SuiteResult } from "../../src/evals/types.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function fakeFetch(responses: Record<string, { status?: number; json?: unknown }> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const r = key ? responses[key]! : {};
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const suite: SuiteResult = {
  suite: "offline", workspace: "/ws", ran_at: "2026-10-15T12:00:00.000Z", cost_usd: 0,
  results: [
    { key: "citation_faithfulness", target: "accounts/a.example/scores/x.md", score: 1, comment: "3/3" },
    { key: "brief_grounding", target: "accounts/a.example/brief.md", score: 0.5, comment: "1/2", failures: ["Snapshot: …"] },
    { key: "claim_support", target: "accounts/b.example/brief.md", score: null, comment: "nothing to check" },
  ],
  summary: { citation_faithfulness: { mean: 1, n: 1, min: 1 }, brief_grounding: { mean: 0.5, n: 1, min: 0.5 } },
};

const LF = { LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-2", LANGFUSE_HOST: "https://lf.example" } as NodeJS.ProcessEnv;
const LS = { LANGSMITH_API_KEY: "lsv2-key", LANGSMITH_PROJECT: "sales" } as NodeJS.ProcessEnv;
const BT = { BRAINTRUST_API_KEY: "bt-key", BRAINTRUST_API_URL: "https://bt.example" } as NodeJS.ProcessEnv;

test("uuidFrom is deterministic and UUID-shaped; dotted order format", () => {
  expect(uuidFrom("x")).toBe(uuidFrom("x"));
  expect(uuidFrom("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(dottedOrder(new Date("2026-10-15T12:00:01.234Z"), "id")).toBe("20261015T120001234000Zid");
});

test("which backends are connected depends only on their keys", () => {
  expect(connectedBackends({}).map((b) => b.id)).toEqual([]);
  expect(connectedBackends({ ...LF, ...LS }).map((b) => b.id)).toEqual(["langfuse", "langsmith"]);
});

describe("Langfuse", () => {
  test("OTLP endpoint + Basic auth", () => {
    expect(langfuse.otlp(LF)).toEqual({ url: "https://lf.example/api/public/otel/v1/traces", headers: { Authorization: `Basic ${Buffer.from("pk-lf-1:sk-lf-2").toString("base64")}` } });
    expect(langfuse.otlp({})).toBeNull();
  });
  test("verify, scores on the eval trace, datasets with stable ids", async () => {
    const { f, calls } = fakeFetch({ "/api/public/projects": { json: { data: [{ name: "shotlift" }] } }, "/v2/datasets": { status: 409 } });
    expect(await langfuse.verify(LF, f)).toEqual({ ok: true, detail: 'project "shotlift" at https://lf.example' });
    const s = await langfuse.pushScores(LF, suite, { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", experiment: "optimized" }, f);
    expect(s.pushed).toBe(4); // 2 results with a score + 2 means; null scores are skipped
    const score = calls.find((c) => c.url.endsWith("/api/public/scores"))!;
    expect(score.body).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", name: "citation_faithfulness", value: 1, dataType: "NUMERIC" });
    const d = await langfuse.pushDataset(LF, "bench", [{ id: "a", input: { x: 1 }, expected: { y: 2 } }], f);
    expect(d.pushed).toBe(1); // 409 on dataset create is fine (already exists)
    const item = calls.find((c) => c.url.endsWith("/dataset-items"))!;
    expect(item.body).toMatchObject({ datasetName: "bench", id: uuidFrom("bench|a"), input: { x: 1 }, expectedOutput: { y: 2 } });
  });
  test("scores without a trace id are refused before any request (Langfuse would answer 400)", async () => {
    const { f, calls } = fakeFetch();
    expect(langfuse.pushScores(LF, suite, { experiment: "bench" }, f)).rejects.toThrow("trace id");
    expect(calls).toHaveLength(0);
  });
  test("verify reports failures instead of throwing", async () => {
    const { f } = fakeFetch({ "/api/public/projects": { status: 401, json: { message: "bad key" } } });
    const r = await langfuse.verify(LF, f);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("401");
  });
});

describe("LangSmith", () => {
  test("OTLP endpoint + headers", () => {
    expect(langsmith.otlp(LS)).toEqual({ url: "https://api.smith.langchain.com/otel/v1/traces", headers: { "x-api-key": "lsv2-key", "Langsmith-Project": "sales" } });
  });
  test("creates an eval run, attaches feedback, creates/reuses the dataset", async () => {
    const { f, calls } = fakeFetch({ "/api/v1/datasets?name=": { json: [] }, "/api/v1/datasets": { json: { id: "ds-1" } } });
    const s = await langsmith.pushScores(LS, suite, { experiment: "optimized" }, f);
    const run = calls.find((c) => c.url.endsWith("/api/v1/runs"))!;
    expect(run.body).toMatchObject({ name: "eval.offline · optimized", run_type: "chain", session_name: "sales" });
    expect(run.body.dotted_order.endsWith(run.body.id)).toBe(true);
    const fb = calls.filter((c) => c.url.endsWith("/api/v1/feedback"));
    expect(fb).toHaveLength(4);
    expect(fb.every((c) => c.body.run_id === run.body.id)).toBe(true);
    expect(s.pushed).toBe(4);
    await langsmith.pushDataset(LS, "bench", [{ id: "a", input: { x: 1 }, expected: { y: 2 } }], f);
    const ex = calls.find((c) => c.url.endsWith("/api/v1/examples"))!;
    expect(ex.body).toMatchObject({ dataset_id: "ds-1", inputs: { input: { x: 1 } }, outputs: { expected: { y: 2 } } });
    expect(ex.headers["x-api-key"]).toBe("lsv2-key");
  });
});

test("dataset items from the golden fixture: context in, score + snapshot out", async () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-ds-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  const items = await buildDataset(ws, "ap-automation-midmarket", "full");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "ap-automation-midmarket/full/maasverhoeven.example", expected: { tier: expect.any(String), levels: { company_size: 3 } } });
  expect((items[0]!.input as { account: { domain: string } }).account.domain).toBe("maasverhoeven.example");
  expect(String((items[0]!.expected as { snapshot: string }).snapshot)).toContain("Maas & Verhoeven");
});

test("traces fan out to every connected backend (and a generic OTLP endpoint)", async () => {
  const { traceTargets } = await import("../../src/core/tracing.ts");
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(ASE_)?(OTEL_|LANGFUSE_|LANGSMITH_)/.test(k)) delete process.env[k];
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ase-xdg-"));
    expect(traceTargets()).toEqual([]);
    Object.assign(process.env, LF, LS, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    expect(traceTargets().map((t) => t.name)).toEqual(["otlp", "langfuse", "langsmith"]);
    expect(traceTargets()[0]!.url).toBe("http://localhost:4318/v1/traces");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("CLI: observability status with nothing connected; dataset push refuses without a backend", () => {
  const xdg = mkdtempSync(join(tmpdir(), "ase-xdg-"));
  const ws = join(mkdtempSync(join(tmpdir(), "ase-obs-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "", LANGSMITH_API_KEY: "", BRAINTRUST_API_KEY: "", OTEL_EXPORTER_OTLP_ENDPOINT: "" };
  const run = (args: string[]) => Bun.spawnSync(["bun", join(PLUGIN_ROOT, "src/cli/ase.ts"), ...args, "--workspace", ws], { env });
  const st = JSON.parse(run(["observability", "status"]).stdout.toString());
  expect(st.backends.map((b: { backend: string; connected: boolean }) => [b.backend, b.connected])).toEqual([["langfuse", false], ["langsmith", false], ["braintrust", false]]);
  const ds = run(["dataset", "push", "--icp", "ap-automation-midmarket"]);
  expect(ds.exitCode).toBe(1);
  expect(ds.stderr.toString()).toContain("observability connect");
  const bad = Bun.spawnSync(["bun", join(PLUGIN_ROOT, "src/cli/ase.ts"), "observability", "connect", "langfuse", "--workspace", ws], { env, stdin: new Blob(["not-a-key"]) });
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain("pk-lf");
});

describe("Braintrust", () => {
  test("OTLP endpoint with bearer auth and the project as parent", () => {
    expect(braintrust.otlp(BT)).toEqual({ url: "https://bt.example/otel/v1/traces", headers: { Authorization: "Bearer bt-key", "x-bt-parent": "project_name:agentic-sales-engine" } });
    expect(braintrust.otlp({})).toBeNull();
    expect(connectedBackends({ ...LF, ...BT }).map((b) => b.id)).toEqual(["langfuse", "braintrust"]);
  });
  test("scores become one experiment, rows keyed by evaluator + target; datasets get stable ids", async () => {
    const { f, calls } = fakeFetch({ "/v1/project": { json: { id: "p1" } }, "/v1/experiment": { json: { id: "e1" } }, "/v1/dataset": { json: { id: "d1" } } });
    expect((await braintrust.verify(BT, f)).ok).toBe(true);
    const s = await braintrust.pushScores(BT, suite, { traceId: "t1", experiment: "optimized" }, f);
    expect(s.pushed).toBe(2); // null scores skipped; Braintrust computes the averages itself
    expect(calls.find((c) => c.url.endsWith("/v1/experiment"))!.body).toMatchObject({ project_id: "p1", metadata: { experiment: "optimized", otel_trace_id: "t1" } });
    const ins = calls.find((c) => c.url.endsWith("/v1/experiment/e1/insert"))!;
    expect(ins.body.events[0]).toMatchObject({ input: { evaluator: "citation_faithfulness", target: "accounts/a.example/scores/x.md" }, scores: { citation_faithfulness: 1 } });
    const d = await braintrust.pushDataset(BT, "bench", [{ id: "a", input: { x: 1 }, expected: { y: 2 } }], f);
    expect(d.pushed).toBe(1);
    expect(calls.find((c) => c.url.endsWith("/v1/dataset/d1/insert"))!.body.events[0]).toMatchObject({ id: uuidFrom("bench|a"), input: { x: 1 }, expected: { y: 2 } });
  });
});
