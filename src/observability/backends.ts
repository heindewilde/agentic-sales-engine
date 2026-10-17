import { createHash } from "node:crypto";
import type { EvalResult, SuiteResult } from "../evals/types.ts";

/**
 * Observability backends — pick any (or several) and connect with one command. Each backend can:
 *   - receive traces (OTLP endpoint + headers, used by tracing.ts),
 *   - receive eval scores (attached to the eval run),
 *   - receive datasets (benchmark accounts as input / expected-output pairs).
 * Adding a backend (Phoenix, Braintrust, …) means implementing this interface and registering it below.
 */

export interface DatasetItem {
  id: string; // stable, so re-pushing updates instead of duplicating
  input: unknown;
  expected: unknown;
  metadata?: Record<string, unknown>;
}

export interface BackendConfig {
  /** credential/env variable names this backend reads */
  keys: readonly string[];
}

export interface Backend {
  id: "langfuse" | "langsmith";
  label: string;
  keys: readonly string[];
  configured(env: NodeJS.ProcessEnv): boolean;
  /** OTLP/HTTP traces endpoint and headers, or null when traces aren't supported */
  otlp(env: NodeJS.ProcessEnv): { url: string; headers: Record<string, string> } | null;
  verify(env: NodeJS.ProcessEnv, f?: typeof fetch): Promise<{ ok: boolean; detail: string }>;
  pushScores(env: NodeJS.ProcessEnv, suite: SuiteResult, ctx: { traceId?: string; experiment?: string }, f?: typeof fetch): Promise<{ pushed: number; ref: string }>;
  pushDataset(env: NodeJS.ProcessEnv, name: string, items: DatasetItem[], f?: typeof fetch): Promise<{ pushed: number; ref: string }>;
}

const numeric = (r: EvalResult): number | null => (r.score === null ? null : typeof r.score === "boolean" ? (r.score ? 1 : 0) : r.score);

/** RFC-4122-shaped UUID derived from a string (deterministic; LangSmith requires UUID ids). */
export function uuidFrom(s: string): string {
  const h = createHash("sha256").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

async function call(f: typeof fetch, url: string, init: RequestInit, okStatuses: number[] = []): Promise<Response> {
  const r = await f(url, init);
  if (!r.ok && !okStatuses.includes(r.status)) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${url} → ${r.status} ${body.slice(0, 200)}`);
  }
  return r;
}

// ---------- Langfuse (open source; cloud or self-hosted) ----------

const lfHost = (env: NodeJS.ProcessEnv) => (env.LANGFUSE_HOST || env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/$/, "");
const lfAuth = (env: NodeJS.ProcessEnv) => `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;

export const langfuse: Backend = {
  id: "langfuse",
  label: "Langfuse",
  keys: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST"],
  configured: (env) => Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY),
  otlp: (env) => (langfuse.configured(env) ? { url: `${lfHost(env)}/api/public/otel/v1/traces`, headers: { Authorization: lfAuth(env) } } : null),
  async verify(env, f = fetch) {
    try {
      const r = await call(f, `${lfHost(env)}/api/public/projects`, { headers: { Authorization: lfAuth(env) } });
      const j = (await r.json()) as { data?: { name?: string }[] };
      return { ok: true, detail: `project "${j.data?.[0]?.name ?? "?"}" at ${lfHost(env)}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },
  async pushScores(env, suite, ctx, f = fetch) {
    // Langfuse rejects scores that aren't attached to a trace, session or dataset run (HTTP 400)
    if (!ctx.traceId) throw new Error("Langfuse scores need a trace id: push from inside a span (see `ase eval run`, bench/run.ts)");
    let n = 0;
    const post = (body: Record<string, unknown>) =>
      call(f, `${lfHost(env)}/api/public/scores`, { method: "POST", headers: { Authorization: lfAuth(env), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const r of suite.results) {
      const v = numeric(r);
      if (v === null) continue;
      await post({ id: uuidFrom(`${suite.ran_at}|${r.key}|${r.target}`), traceId: ctx.traceId, name: r.key, value: v, dataType: "NUMERIC", comment: `${r.target}: ${r.comment}`, metadata: { target: r.target, failures: r.failures?.slice(0, 10), suite: suite.suite, experiment: ctx.experiment } });
      n++;
    }
    for (const [k, s] of Object.entries(suite.summary)) {
      if (s.mean === null) continue;
      await post({ id: uuidFrom(`${suite.ran_at}|${k}|mean`), traceId: ctx.traceId, name: `${k}.mean`, value: s.mean, dataType: "NUMERIC", comment: `mean over ${s.n}`, metadata: { suite: suite.suite, experiment: ctx.experiment } });
      n++;
    }
    return { pushed: n, ref: ctx.traceId ? `${lfHost(env)} trace ${ctx.traceId}` : lfHost(env) };
  },
  async pushDataset(env, name, items, f = fetch) {
    const h = { Authorization: lfAuth(env), "Content-Type": "application/json" };
    await call(f, `${lfHost(env)}/api/public/v2/datasets`, { method: "POST", headers: h, body: JSON.stringify({ name, description: "agentic-sales-engine benchmark accounts" }) }, [409]);
    for (const it of items) {
      await call(f, `${lfHost(env)}/api/public/dataset-items`, { method: "POST", headers: h, body: JSON.stringify({ datasetName: name, id: uuidFrom(`${name}|${it.id}`), input: it.input, expectedOutput: it.expected, metadata: { ...it.metadata, key: it.id } }) });
    }
    return { pushed: items.length, ref: `${lfHost(env)} dataset "${name}"` };
  },
};

// ---------- LangSmith (hosted by LangChain) ----------

const lsHost = (env: NodeJS.ProcessEnv) => (env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com").replace(/\/$/, "");
const lsHeaders = (env: NodeJS.ProcessEnv) => ({ "x-api-key": env.LANGSMITH_API_KEY ?? "", "Content-Type": "application/json" });
const lsProject = (env: NodeJS.ProcessEnv) => env.LANGSMITH_PROJECT || "agentic-sales-engine";

/** LangSmith dotted_order: <YYYYMMDDTHHMMSSffffff>Z<run id> */
export function dottedOrder(d: Date, id: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds() * 1000, 6)}Z${id}`;
}

export const langsmith: Backend = {
  id: "langsmith",
  label: "LangSmith",
  keys: ["LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT", "LANGSMITH_PROJECT"],
  configured: (env) => Boolean(env.LANGSMITH_API_KEY),
  otlp: (env) => (langsmith.configured(env) ? { url: `${lsHost(env)}/otel/v1/traces`, headers: { "x-api-key": env.LANGSMITH_API_KEY!, "Langsmith-Project": lsProject(env) } } : null),
  async verify(env, f = fetch) {
    try {
      await call(f, `${lsHost(env)}/api/v1/datasets?limit=1`, { headers: lsHeaders(env) });
      return { ok: true, detail: `project "${lsProject(env)}" at ${lsHost(env)}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },
  async pushScores(env, suite, ctx, f = fetch) {
    // LangSmith can't link OTLP span ids to run ids, so the eval run is created explicitly and scores attach as feedback.
    const id = uuidFrom(`eval|${suite.ran_at}|${suite.suite}|${ctx.experiment ?? ""}`);
    const start = new Date(suite.ran_at);
    await call(f, `${lsHost(env)}/api/v1/runs`, {
      method: "POST", headers: lsHeaders(env),
      body: JSON.stringify({
        id, trace_id: id, dotted_order: dottedOrder(start, id), name: `eval.${suite.suite}${ctx.experiment ? ` · ${ctx.experiment}` : ""}`, run_type: "chain",
        start_time: start.toISOString(), end_time: new Date().toISOString(), session_name: lsProject(env),
        inputs: { suite: suite.suite, experiment: ctx.experiment ?? null, otel_trace_id: ctx.traceId ?? null }, outputs: { summary: suite.summary, cost_usd: suite.cost_usd },
      }),
    }, [409]);
    let n = 0;
    const fb = (body: Record<string, unknown>) => call(f, `${lsHost(env)}/api/v1/feedback`, { method: "POST", headers: lsHeaders(env), body: JSON.stringify({ run_id: id, ...body }) });
    for (const r of suite.results) {
      const v = numeric(r);
      if (v === null) continue;
      await fb({ id: uuidFrom(`${id}|${r.key}|${r.target}`), key: r.key, score: v, comment: `${r.target}: ${r.comment}`, extra: { target: r.target, failures: r.failures?.slice(0, 10) } });
      n++;
    }
    for (const [k, s] of Object.entries(suite.summary)) {
      if (s.mean === null) continue;
      await fb({ id: uuidFrom(`${id}|${k}|mean`), key: `${k}.mean`, score: s.mean, comment: `mean over ${s.n}` });
      n++;
    }
    return { pushed: n, ref: `${lsHost(env)} project "${lsProject(env)}" run ${id}` };
  },
  async pushDataset(env, name, items, f = fetch) {
    const found = (await (await call(f, `${lsHost(env)}/api/v1/datasets?name=${encodeURIComponent(name)}&limit=1`, { headers: lsHeaders(env) })).json()) as { id: string }[];
    let datasetId = found[0]?.id;
    if (!datasetId) {
      const created = (await (await call(f, `${lsHost(env)}/api/v1/datasets`, { method: "POST", headers: lsHeaders(env), body: JSON.stringify({ name, description: "agentic-sales-engine benchmark accounts" }) })).json()) as { id: string };
      datasetId = created.id;
    }
    for (const it of items) {
      await call(f, `${lsHost(env)}/api/v1/examples`, {
        method: "POST", headers: lsHeaders(env),
        body: JSON.stringify({ id: uuidFrom(`${name}|${it.id}`), dataset_id: datasetId, inputs: { input: it.input }, outputs: { expected: it.expected }, metadata: { ...it.metadata, key: it.id } }),
      }, [409]);
    }
    return { pushed: items.length, ref: `${lsHost(env)} dataset "${name}"` };
  },
};

export const BACKENDS: Backend[] = [langfuse, langsmith];

export const connectedBackends = (env: NodeJS.ProcessEnv = process.env) => BACKENDS.filter((b) => b.configured(env));
