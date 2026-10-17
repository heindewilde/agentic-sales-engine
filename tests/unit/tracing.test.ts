import { afterEach, expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistCandidates } from "../../src/core/accounts.ts";
import { runBatch } from "../../src/core/batch.ts";
import { callProvider } from "../../src/core/providers/gateway.ts";
import type { Adapter, AdapterResult, Op, OpInputs } from "../../src/core/providers/types.ts";
import { writeScore } from "../../src/core/scorefile.ts";
import { initTracing, shutdownTracing, startSpan, withSpan } from "../../src/core/tracing.ts";
import { streamCollector } from "../../src/core/headless.ts";
import { makeWorkspace, PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
// never read the user's real credentials file: a connected backend would turn tracing on and export test spans to it
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ase-xdg-"));
afterEach(async () => {
  delete process.env.TRACEPARENT;
  delete process.env.ASE_TRACE_CONTENT;
  await shutdownTracing();
});

const fakeExa: Adapter = {
  name: "exa", supports: ["search_news"],
  async run<O extends Op>(_op: O, _i: OpInputs[O]): Promise<AdapterResult<O>> {
    return { results: [{ title: "t", url: "https://n.example/a", published: "2026-10-01", summary: "s" }], cost_usd: 0.012, cost_kind: "actual" } as AdapterResult<O>;
  },
};

test("tracing is a no-op without an endpoint", async () => {
  expect(initTracing("test")).toBe(false);
  expect(await withSpan("x", {}, async () => 42)).toBe(42);
});

test("alsoTargets keeps the explicit exporter when no backend is configured", async () => {
  const exp = new InMemorySpanExporter();
  expect(initTracing("test", { exporter: exp, alsoTargets: true })).toBe(true);
  await withSpan("bench", {}, async () => {});
  expect(exp.getFinishedSpans().map((s) => s.name)).toEqual(["bench"]);
  await shutdownTracing();
});

test("provider calls become spans with cost and outcome; parent taken from TRACEPARENT", async () => {
  const exp = new InMemorySpanExporter();
  initTracing("test", { exporter: exp });
  process.env.TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const ws = makeWorkspace();
  await callProvider("search_news", { query: "acme funding", since: "2026-01-01" }, { ws, adapters: { exa: fakeExa }, mode: "live" });
  await callProvider("search_news", { query: "x", since: "not a date" }, { ws, adapters: { exa: fakeExa }, mode: "live" }).catch(() => {});
  const [ok, bad] = exp.getFinishedSpans();
  expect(ok!.name).toBe("provider.search_news");
  expect(ok!.attributes).toMatchObject({ "ase.provider": "exa", "ase.cost_usd": 0.012, "ase.cost_kind": "actual", "ase.results": 1 });
  expect(ok!.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  expect(bad!.attributes["ase.error_code"]).toBe("bad_input");
  expect(bad!.status.code).toBe(2);
});

test("batch run → chunk spans (with child-process traceparent) → score spans; no content by default", async () => {
  const exp = new InMemorySpanExporter();
  initTracing("test", { exporter: exp });
  const ws = join(mkdtempSync(join(tmpdir(), "ase-tr-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  await persistCandidates(ws, ICP, "r", "t", [{ name: "P0", domain: "p0.example", source_url: "https://p0.example" }, { name: "P1", domain: "p1.example", source_url: "https://p1.example" }]);
  const seenParents: (string | undefined)[] = [];
  const runner = async ({ prompt, span }: { prompt: string; span?: import("@opentelemetry/api").Span }) => {
    seenParents.push(span?.spanContext().spanId);
    for (const d of prompt.split("\n")[0]!.match(/[a-z0-9-]+\.example/g) ?? []) {
      await writeScore({ ws, icp: ICP, domain: d, mode: "light", judgements: [{ id: "industry_fit", level: 2, confidence: 0.8, evidence: [{ quote: "q", source_url: `https://${d}` }] }] });
    }
    return { cost_usd: 0.05, ok: true, summary: "secret prompt text here" };
  };
  await runBatch({ ws, skill: "enrich-light", icp: ICP, pluginRoot: PLUGIN_ROOT, chunk: 1, concurrency: 1, budgetUsd: 1, runner, log: () => {} });
  const spans = exp.getFinishedSpans();
  const run = spans.find((s) => s.name === "batch.run")!;
  const chunks = spans.filter((s) => s.name === "batch.chunk");
  const scores = spans.filter((s) => s.name === "score.compute");
  expect(chunks).toHaveLength(2);
  expect(chunks.every((c) => c.parentSpanContext?.spanId === run.spanContext().spanId)).toBe(true);
  expect(chunks[0]!.attributes).toMatchObject({ "ase.cost_usd": 0.05, "ase.ok": true, "ase.advanced": 1 });
  expect(seenParents).toEqual(chunks.map((c) => c.spanContext().spanId));
  expect(scores).toHaveLength(2);
  expect(scores[0]!.attributes).toMatchObject({ "ase.mode": "light", "ase.stage": "light_scored" });
  expect(run.attributes).toMatchObject({ "ase.processed": 2, "ase.advanced": 2 });
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("secret prompt text");
});

test("a session stream becomes agent → generation per turn → tools, subagents nested; content only when enabled", async () => {
  const run = async () => {
    const exp = new InMemorySpanExporter();
    initTracing("test", { exporter: exp });
    const session = startSpan("batch.chunk", {});
    const c = streamCollector(session, "research acme.example");
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 };
    // one message streamed as two blocks (same id), then a subagent turn under the Agent call
    c.add({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Looking up." }], usage } });
    c.add({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: "judge" } }], usage } });
    c.add({ type: "assistant", parent_tool_use_id: "a1", message: { id: "m2", model: "claude-haiku-5-5", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file: "x" } }], usage } });
    c.add({ type: "user", parent_tool_use_id: "a1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file text" }] } });
    c.add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "level 3" }] } });
    c.add({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.1, num_turns: 2, usage });
    c.finish();
    session.end();
    const spans = exp.getFinishedSpans();
    await shutdownTracing();
    return spans;
  };
  const spans = await run();
  const by = (n: string) => spans.filter((s) => s.name === n);
  expect(by("llm.turn")).toHaveLength(2); // two messages, not three blocks
  const [turn1, turn2] = by("llm.turn");
  expect(turn1!.attributes).toMatchObject({ "openinference.span.kind": "LLM", "langfuse.observation.type": "generation", "llm.model_name": "claude-sonnet-5-5", "llm.token_count.prompt": 110, "llm.token_count.completion": 5 });
  const agentTool = by("tool.Agent")[0]!;
  expect(turn2!.parentSpanContext?.spanId).toBe(agentTool.spanContext().spanId); // subagent turn nests under the Agent call
  expect(by("tool.Read")[0]!.parentSpanContext?.spanId).toBe(agentTool.spanContext().spanId);
  expect(by("batch.chunk")[0]!.attributes).toMatchObject({ "openinference.span.kind": "AGENT", "ase.turns": 2 });
  expect(spans.some((s) => "input.value" in s.attributes || "output.value" in s.attributes)).toBe(false);
  process.env.ASE_TRACE_CONTENT = "1";
  const withContent = await run();
  expect(withContent.find((s) => s.name === "batch.chunk")!.attributes).toMatchObject({ "input.value": "research acme.example", "output.value": "done" });
  expect(withContent.find((s) => s.name === "tool.Read")!.attributes).toMatchObject({ "input.value": '{"file":"x"}', "output.value": "file text" });
});
