import type { Span } from "@opentelemetry/api";
import type { ChunkRunner, ChunkRunResult } from "./batch.ts";
import { claudeBilling } from "./billing.ts";
import { emptyLimit, observeLimit } from "./limits.ts";
import { childTracingEnv, kindAttrs, setAttrs, setIO, startSpan, usageAttrs, withSpan } from "./tracing.ts";

/**
 * Headless Claude sessions for batch work. Two transports, same message stream:
 *   cliRunner — `claude -p --output-format stream-json`: Claude Code's own headless mode, on whatever login Claude
 *               Code has (a claude.ai subscription or an API key). The default on a subscription.
 *   sdkRunner — the Agent SDK (src/core/batch.ts): for API-key setups (servers, CI).
 */

export const MODEL_ALIASES: Record<string, string> = { haiku: "haiku", sonnet: "sonnet", opus: "opus" };

export const allowedTools = (pluginRoot: string) => [
  "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebSearch", "WebFetch",
  `Bash(bun ${pluginRoot}/src/cli/ase.ts *)`,
  "mcp__plugin_agentic-sales-engine_ase",
];

/** Environment for a headless session: provider keys under ASE_* (the plugin's .mcp.json would blank the plain names) and trace context. */
export function sessionEnv(span?: Span): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  for (const k of ["EXA_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL"]) if (env[k]) env[`ASE_${k}`] = env[k]!;
  return Object.assign(env, childTracingEnv(span));
}

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/**
 * Folds a session's message stream into a chunk result: cost, outcome, denied tool calls, usage limits. With a span it
 * also records the session as a trace: the session (agent) → one generation per model turn → one span per tool call,
 * with subagent turns nested under the Agent tool call that started them. Prompts and outputs only with ASE_TRACE_CONTENT=1.
 */
export function streamCollector(span?: Span, prompt?: string) {
  const toolSpans = new Map<string, Span>();
  const pending = new Map<string, string>();
  const denied: string[] = [];
  const limit = emptyLimit();
  let cost = 0;
  let ok = false;
  let summary = "";
  let model: string | undefined;
  // Claude Code streams one assistant event per content block; blocks of the same message share its id.
  let turn: { id: string; span: Span; out: Block[]; usage?: Usage; model?: string } | null = null;
  let lastEvent = Date.now();
  if (span) {
    setAttrs(span, kindAttrs("agent"));
    setIO(span, { input: prompt });
  }
  const parentFor = (parentToolUseId: unknown) => (typeof parentToolUseId === "string" && toolSpans.get(parentToolUseId)) || span;
  const closeTurn = () => {
    if (!turn) return;
    const u = turn.usage ?? {};
    setAttrs(turn.span, usageAttrs({ model: turn.model, input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }));
    setIO(turn.span, { output: turn.out.map((b) => (b.type === "text" ? { text: b.text } : b.type === "tool_use" ? { tool_use: b.name, input: b.input } : b.type === "thinking" ? { thinking: b.thinking } : { type: b.type })) });
    turn.span.end();
    turn = null;
  };
  return {
    add(m: Record<string, unknown>) {
      observeLimit(limit, m);
      const now = Date.now();
      if (m.type === "assistant") {
        const msg = (m as { message?: { id?: string; model?: string; content?: unknown; usage?: Usage } }).message ?? {};
        const blocks = (msg.content ?? []) as Block[];
        if (msg.model) model = msg.model;
        if (span) {
          if (!turn || turn.id !== (msg.id ?? "")) {
            closeTurn();
            turn = { id: msg.id ?? "", span: startSpan("llm.turn", { ...kindAttrs("llm"), "gen_ai.operation.name": "chat" }, parentFor(m.parent_tool_use_id), lastEvent), out: [], model: msg.model };
          }
          turn.out.push(...blocks);
          if (msg.usage) turn.usage = msg.usage;
        }
        // Record tool calls so refused ones show up in batch logs instead of as silent non-progress.
        for (const c of blocks) {
          if (c.type === "tool_use" && c.id) {
            pending.set(c.id, `${c.name} ${JSON.stringify(c.input).slice(0, 300)}`);
            if (span) {
              const t = startSpan(`tool.${c.name}`, { ...kindAttrs("tool"), "ase.tool": c.name, "tool.name": c.name }, parentFor(m.parent_tool_use_id));
              setIO(t, { input: c.input });
              toolSpans.set(c.id, t);
            }
          }
        }
      } else if (m.type === "user" || m.type === "result") {
        closeTurn();
      }
      if (m.type === "user") {
        const content = (m as { message?: { content?: unknown } }).message?.content;
        for (const c of Array.isArray(content) ? (content as Block[]) : []) {
          if (c.type === "tool_result" && c.is_error && /permission|denied|not allowed/i.test(JSON.stringify(c.content))) {
            denied.push(pending.get(c.tool_use_id ?? "") ?? "unknown tool");
          }
          const t = c.type === "tool_result" ? toolSpans.get(c.tool_use_id ?? "") : undefined;
          if (t) {
            setAttrs(t, { "ase.tool_error": Boolean(c.is_error) });
            setIO(t, { output: c.content });
            if (c.is_error) t.setStatus({ code: 2 });
            t.end();
            toolSpans.delete(c.tool_use_id ?? "");
          }
        }
      }
      if (m.type === "result") {
        const r = m as { subtype: string; is_error?: boolean; total_cost_usd?: number; result?: string; num_turns?: number; usage?: Usage };
        if (span) {
          setAttrs(span, { "ase.turns": r.num_turns, "ase.result": r.subtype, ...usageAttrs({ model, input: r.usage?.input_tokens, output: r.usage?.output_tokens, cacheRead: r.usage?.cache_read_input_tokens, cacheWrite: r.usage?.cache_creation_input_tokens }) });
          setIO(span, { output: r.result ?? r.subtype });
        }
        cost = r.total_cost_usd ?? 0;
        ok = r.subtype === "success" && !r.is_error;
        summary = String(r.result ?? r.subtype).slice(0, 2000);
      }
      lastEvent = now;
    },
    finish(): ChunkRunResult {
      closeTurn();
      for (const t of toolSpans.values()) t.end(); // tools still open when the session stopped
      if (span && (limit.limited || limit.overage)) setAttrs(span, { "ase.usage_limited": limit.limited, "ase.usage_overage": limit.overage, "ase.usage_resets_at": limit.resetsAt ?? undefined });
      return { cost_usd: cost, ok: ok && !limit.limited, summary, denied, limit: limit.limited || limit.overage ? limit : undefined };
    },
  };
}

/** One `claude -p` session per chunk (stream-json), on the login Claude Code already has. */
export const cliRunner: ChunkRunner = async ({ ws, prompt, model, maxBudgetUsd, pluginRoot, span }) => {
  const args = [
    process.env.ASE_CLAUDE_BIN || "claude", "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", MODEL_ALIASES[model] ?? model,
    "--plugin-dir", pluginRoot,
    "--setting-sources", "",
    "--permission-mode", "dontAsk",
    "--allowedTools", ...allowedTools(pluginRoot),
  ];
  // A per-session dollar cap only means something when tokens are billed; on a subscription the plan's own limits apply.
  if (claudeBilling() === "api") args.push("--max-budget-usd", String(maxBudgetUsd));
  const proc = Bun.spawn(args, { cwd: ws, env: sessionEnv(span), stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const c = streamCollector(span, prompt);
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        c.add(JSON.parse(line));
      } catch {
        // non-JSON noise (e.g. a warning line) — ignore
      }
    }
  }
  if (buf.trim()) {
    try {
      c.add(JSON.parse(buf));
    } catch {
      /* ignore */
    }
  }
  const code = await proc.exited;
  const r = c.finish();
  if (code !== 0 && !r.ok && !r.summary) r.summary = `claude -p exited ${code}: ${(await new Response(proc.stderr).text()).slice(0, 500)}`;
  return r;
};

/**
 * Effort for one-shot judging (second opinions, LLM evals): picking a level against an anchor needs little reasoning,
 * and an unbounded think on a hard call can cost 20× a normal one. Override with ASE_JUDGE_EFFORT.
 */
export const judgeEffort = () => (process.env.ASE_JUDGE_EFFORT || "low") as "low" | "medium" | "high";

/** One question, one answer, no tools: `claude -p` on the user's Claude Code login. */
export interface AskResult {
  text: string;
  cost_usd: number;
  /** output and thinking tokens, when the transport reports them (for diagnosing cost) */
  tokens?: { out: number; thinking: number };
}

export async function askOnceCli(prompt: string, opts: { model: string }): Promise<AskResult> {
  const args = [process.env.ASE_CLAUDE_BIN || "claude", "-p", "--output-format", "json", "--model", MODEL_ALIASES[opts.model] ?? opts.model, "--effort", judgeEffort(), "--tools", "", "--setting-sources", ""];
  const proc = Bun.spawn(args, { env: sessionEnv(), stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    const r = JSON.parse(out) as { result?: string; total_cost_usd?: number; usage?: { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } } };
    return { text: r.result ?? "", cost_usd: r.total_cost_usd ?? 0, tokens: { out: r.usage?.output_tokens ?? 0, thinking: r.usage?.output_tokens_details?.thinking_tokens ?? 0 } };
  } catch {
    return { text: out, cost_usd: 0 };
  }
}

/** One question via the Agent SDK (API-key setups). */
export async function askOnceSdk(prompt: string, opts: { model: string }): Promise<AskResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let text = "";
  let cost = 0;
  for await (const m of query({ prompt, options: { model: MODEL_ALIASES[opts.model] ?? opts.model, tools: [], allowedTools: [], settingSources: [], maxTurns: 1, permissionMode: "dontAsk", effort: judgeEffort() } })) {
    if (m.type === "result") {
      const r = m as { result?: string; total_cost_usd?: number };
      text = r.result ?? "";
      cost = r.total_cost_usd ?? 0;
    }
  }
  return { text, cost_usd: cost };
}

/** The right one-shot transport for this billing mode (ASE_HEADLESS=cli|sdk overrides), traced as one generation. */
export function askOnce(billing = claudeBilling()) {
  const forced = process.env.ASE_HEADLESS;
  const transport = forced === "sdk" ? askOnceSdk : forced === "cli" ? askOnceCli : billing === "api" ? askOnceSdk : askOnceCli;
  return (prompt: string, opts: { model: string }): Promise<AskResult> =>
    withSpan("llm.ask", { ...kindAttrs("llm"), "gen_ai.operation.name": "chat", "llm.model_name": opts.model, "gen_ai.request.model": opts.model, "ase.effort": judgeEffort() }, async (span) => {
      setIO(span, { input: prompt });
      const r = await transport(prompt, opts);
      setIO(span, { output: r.text });
      setAttrs(span, { "ase.cost_usd": r.cost_usd, "gen_ai.usage.cost": r.cost_usd, "llm.token_count.completion": r.tokens?.out, "gen_ai.usage.output_tokens": r.tokens?.out, "ase.thinking_tokens": r.tokens?.thinking });
      return r;
    });
}
