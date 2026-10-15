import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

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
const env = (name: string): string | undefined => process.env[name] || process.env[`ASE_${name}`] || undefined;

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

export function tracingConfigured(): boolean {
  return Boolean(tracesUrl()) && env("OTEL_SDK_DISABLED") !== "true";
}

/** Variables a child process needs to continue this trace (namespaced so Claude Code passes them through). */
export function childTracingEnv(span?: Span): Record<string, string> {
  if (!tracingConfigured()) return {};
  const out: Record<string, string> = { ASE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesUrl()! };
  const h = env("OTEL_EXPORTER_OTLP_TRACES_HEADERS") ?? env("OTEL_EXPORTER_OTLP_HEADERS");
  if (h) out.ASE_OTEL_EXPORTER_OTLP_HEADERS = h;
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
export function initTracing(component: string, opts: { exporter?: SpanExporter; version?: string; immediate?: boolean } = {}): boolean {
  if (provider) return true;
  if (!opts.exporter && !tracingConfigured()) return false;
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": NAME, "service.version": opts.version ?? "0.10.0", "ase.component": component }),
    spanProcessors: [opts.exporter ? new SimpleSpanProcessor(opts.exporter) : opts.immediate ? new SimpleSpanProcessor(exporter()) : new BatchSpanProcessor(exporter())],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return true;
}

const exporter = () => new OTLPTraceExporter({ url: tracesUrl(), headers: otlpHeaders() });

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
export function startSpan(name: string, attrs: Record<string, unknown>, parent?: Span): Span {
  const ctx = parent ? trace.setSpan(context.active(), parent) : parentContext();
  return trace.getTracer(NAME).startSpan(name, { attributes: clean(attrs) }, ctx);
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
