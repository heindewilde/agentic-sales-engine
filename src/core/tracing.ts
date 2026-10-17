import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { BACKENDS, connectedBackends } from "../observability/backends.ts";
import { credentialFileValues } from "./credentials.ts";

/**
 * Optional OpenTelemetry tracing — works with any OTLP backend (Langfuse, LangSmith, Phoenix, Jaeger, Honeycomb, Grafana…).
 * Off unless an endpoint is configured via the standard variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) and, if needed, OTEL_EXPORTER_OTLP_HEADERS.
 * Privacy: spans carry metadata only (operations, domains, costs, durations, outcomes). Prompt, page and draft
 * text is added only when ASE_TRACE_CONTENT=1. Trace context crosses process boundaries (batch driver → headless
 * session → MCP gateway) through the TRACEPARENT environment variable.
 */

const NAME = "agentic-sales-engine";
let provider: BasicTracerProvider | null = null;

/**
 * Settings are read from the standard OTEL_* variables, falling back to ASE_-prefixed copies. Claude Code doesn't pass
 * OTEL_* or TRACEPARENT to its own child processes (MCP servers, Bash), so the batch driver forwards ASE_* copies.
 */
const env = (name: string): string | undefined => process.env[name] || process.env[`ASE_${name}`] || fileVars()[name] || undefined;
let fileCache: Record<string, string> | null = null;
const fileVars = () => (fileCache ??= credentialFileValues());

export function tracesUrl(): string | undefined {
  const t = env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  if (t) return t;
  const base = env("OTEL_EXPORTER_OTLP_ENDPOINT");
  return base ? `${base.replace(/\/$/, "")}/v1/traces` : undefined;
}

export function otlpHeaders(): Record<string, string> {
  const raw = env("OTEL_EXPORTER_OTLP_TRACES_HEADERS") ?? env("OTEL_EXPORTER_OTLP_HEADERS") ?? "";
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

/** Every place traces should go: a generic OTLP endpoint and/or each connected observability backend. */
export function traceTargets(): { name: string; url: string; headers: Record<string, string> }[] {
  if (env("OTEL_SDK_DISABLED") === "true") return [];
  const out: { name: string; url: string; headers: Record<string, string> }[] = [];
  if (tracesUrl()) out.push({ name: "otlp", url: tracesUrl()!, headers: otlpHeaders() });
  for (const b of connectedBackends(backendEnv())) {
    const o = b.otlp(backendEnv());
    if (o) out.push({ name: b.id, ...o });
  }
  return out;
}

/** Backend credentials as seen by this process (env, or ASE_-prefixed copies forwarded by the batch driver). */
function backendEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...fileVars(), ...process.env };
  for (const b of BACKENDS) for (const k of b.keys) if (!e[k] && process.env[`ASE_${k}`]) e[k] = process.env[`ASE_${k}`];
  return e;
}

export function tracingConfigured(): boolean {
  return traceTargets().length > 0;
}

/** Variables a child process needs to continue this trace (namespaced so Claude Code passes them through). */
export function childTracingEnv(span?: Span): Record<string, string> {
  if (!tracingConfigured()) return {};
  const out: Record<string, string> = {};
  if (tracesUrl()) out.ASE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = tracesUrl()!;
  const h = env("OTEL_EXPORTER_OTLP_TRACES_HEADERS") ?? env("OTEL_EXPORTER_OTLP_HEADERS");
  if (h) out.ASE_OTEL_EXPORTER_OTLP_HEADERS = h;
  const be = backendEnv();
  for (const b of connectedBackends(be)) for (const k of b.keys) if (be[k]) out[`ASE_${k}`] = be[k]!;
  if (process.env.ASE_TRACE_CONTENT) out.ASE_TRACE_CONTENT = process.env.ASE_TRACE_CONTENT;
  const tp = span ? traceparentFor(span) : undefined;
  if (tp) {
    out.TRACEPARENT = tp;
    out.ASE_TRACEPARENT = tp;
  }
  return out;
}

export function includeContent(): boolean {
  return process.env.ASE_TRACE_CONTENT === "1";
}


/** Start tracing for this process if configured (or with an explicit exporter, for tests). Idempotent. */
/** `immediate` exports each span as it ends (for long-lived or abruptly-stopped processes like the MCP gateway). */
/** `alsoTargets` keeps an explicit exporter (e.g. the benchmark's in-memory one) and also sends to configured backends. */
export function initTracing(component: string, opts: { exporter?: SpanExporter; version?: string; immediate?: boolean; alsoTargets?: boolean } = {}): boolean {
  if (provider) return true;
  fileCache = null; // re-read the credentials file on every init (e.g. after `observability connect`)
  if (!opts.exporter && !tracingConfigured()) return false;
  const targets = !opts.exporter || opts.alsoTargets
    ? traceTargets().map((t) => {
        const exp = new OTLPTraceExporter({ url: t.url, headers: t.headers });
        return opts.immediate ? new SimpleSpanProcessor(exp) : new BatchSpanProcessor(exp);
      })
    : [];
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": NAME, "service.version": opts.version ?? "0.10.0", "ase.component": component }),
    spanProcessors: [...(opts.exporter ? [new SimpleSpanProcessor(opts.exporter)] : []), ...targets],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return true;
}

export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  await provider.shutdown().catch(() => {});
  provider = null;
  trace.disable();
  context.disable();
  propagation.disable();
}

/** Parent context: the active span, else a TRACEPARENT handed down by a parent process. */
function parentContext(): Context {
  if (trace.getSpan(context.active())) return context.active();
  const tp = process.env.TRACEPARENT || process.env.ASE_TRACEPARENT;
  if (!tp) return context.active();
  return propagation.extract(ROOT_CONTEXT, { traceparent: tp, tracestate: process.env.TRACESTATE ?? "" });
}

const clean = (a: Record<string, unknown>): Attributes => {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : Array.isArray(v) ? v.map(String) : JSON.stringify(v);
  }
  return out;
};

/** Run `fn` inside a span. No-op overhead when tracing is off (the API returns non-recording spans). */
export async function withSpan<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(NAME);
  return tracer.startActiveSpan(name, { attributes: clean(attrs) }, parentContext(), async (span) => {
    try {
      const r = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Start a span you end yourself (e.g. one per tool call observed in a message stream). */
export function startSpan(name: string, attrs: Record<string, unknown>, parent?: Span, startTime?: number): Span {
  const ctx = parent ? trace.setSpan(context.active(), parent) : parentContext();
  return trace.getTracer(NAME).startSpan(name, { attributes: clean(attrs), startTime }, ctx);
}

/**
 * What a span is, in the vocabulary of each backend: OpenInference (Arize, LangSmith, Langfuse, Braintrust), Langfuse's
 * observation types and LangSmith's run types. One set of attributes, so every connected tool shows the same tree.
 */
export type SpanKind = "agent" | "llm" | "tool" | "chain" | "evaluator";
export function kindAttrs(kind: SpanKind): Record<string, string> {
  return {
    "openinference.span.kind": kind === "evaluator" ? "EVALUATOR" : kind.toUpperCase(),
    "langfuse.observation.type": kind === "llm" ? "generation" : kind,
    "langsmith.span.kind": kind === "llm" || kind === "tool" ? kind : "chain",
  };
}

/** Model and token usage under the OpenInference and gen_ai names (LangSmith and Langfuse read either). */
export function usageAttrs(u: { model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): Record<string, unknown> {
  const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return {
    "llm.model_name": u.model, "gen_ai.request.model": u.model,
    "llm.token_count.prompt": u.input === undefined ? undefined : prompt,
    "llm.token_count.completion": u.output,
    "llm.token_count.total": u.input === undefined && u.output === undefined ? undefined : prompt + (u.output ?? 0),
    "llm.token_count.prompt_details.cache_read": u.cacheRead,
    "llm.token_count.prompt_details.cache_write": u.cacheWrite,
    "gen_ai.usage.input_tokens": u.input === undefined ? undefined : prompt, "gen_ai.usage.output_tokens": u.output,
  };
}

const IO_LIMIT = 16_000;
/** Input/output shown in each tool's input and output panels. Content, so only with ASE_TRACE_CONTENT=1. */
export function setIO(span: Span, io: { input?: unknown; output?: unknown }): void {
  if (!includeContent()) return;
  const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, IO_LIMIT);
  if (io.input !== undefined) span.setAttribute("input.value", str(io.input));
  if (io.output !== undefined) span.setAttribute("output.value", str(io.output));
}

export function setAttrs(span: Span, attrs: Record<string, unknown>): void {
  span.setAttributes(clean(attrs));
}

/** Content attributes are only recorded when explicitly enabled. */
export function setContent(span: Span, key: string, value: string | undefined): void {
  if (includeContent() && value) span.setAttribute(key, value.slice(0, 4000));
}

/** W3C traceparent for the given span, to hand to a child process (env TRACEPARENT). */
export function traceparentFor(span: Span): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier);
  return carrier.traceparent;
}
