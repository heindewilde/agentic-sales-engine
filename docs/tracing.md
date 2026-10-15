# Tracing (OpenTelemetry)

Tracing shows what the engine did, step by step. Each trace covers a batch run, broken down into chunks. Inside a
chunk you can see every tool call the headless Claude session made, every provider call the gateway made (with real
cost) and every score computation, all linked even though they run in different processes.

It uses standard OTLP over HTTP, so any backend works. It's **off** until you set an endpoint.

```text
batch.run                         skill, ICP, accounts, advanced, spent
└─ batch.chunk                    domains, model, tokens, cost, ok, denied tool calls
   ├─ tool.<name>                 every tool call in the session (duration, error)
   ├─ provider.<op>  [gateway]    provider, cost (actual or estimated), results, DNC drops, raw_ref, error code
   └─ score.compute  [cli]        ICP, account, mode, total, tier, stage
eval.<suite>                      mean per evaluator
```

## Enable

Set the standard variables in your shell, in the workspace `.env`, or in
`~/.config/agentic-sales-engine/credentials.env`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://<your-backend>/<otlp-path>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<token>   # if your backend needs auth (URL-encoded)
# optional: ASE_TRACE_CONTENT=1   also record tool inputs (off by default — see Privacy)
```

The batch driver forwards these settings and the trace context to the headless sessions it starts, which is why
gateway and CLI spans nest under the right chunk. Claude Code itself doesn't pass `OTEL_*` variables to its child
processes, so the engine forwards `ASE_`-prefixed copies.

## Backends

| Backend | Endpoint | Auth header |
|---|---|---|
| **Langfuse** (open source; self-host or cloud) | `https://cloud.langfuse.com/api/public/otel` (or your host) | `Authorization=Basic <base64(public_key:secret_key)>` |
| **LangSmith** | `https://api.smith.langchain.com/otel` | `x-api-key=<key>` (+ `Langsmith-Project=<name>`) |
| **Arize Phoenix** (open source, local) | `http://localhost:6006` | none |
| **Jaeger** (local) | `http://localhost:4318` | none |
| Honeycomb, Grafana Tempo, Datadog… | their OTLP/HTTP endpoint | per vendor |

Check each vendor's docs for the current endpoint path. Some want the full `/v1/traces` URL, which you can set with
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` instead.

## Interactive Claude Code sessions

The MCP gateway traces provider calls in interactive sessions too, if the variables are set in the environment you start
Claude Code from. Claude Code also has its own OpenTelemetry export for metrics and events (`CLAUDE_CODE_ENABLE_TELEMETRY=1`
plus the OTEL exporter variables; see the Claude Code monitoring docs). The two complement each other.

## Privacy

By default spans contain metadata only: operations, account domains, costs, durations, outcomes and error codes. They
never contain prompts, page text, drafts or personal data. `ASE_TRACE_CONTENT=1` adds tool inputs (truncated), which can
include prospect information, so only enable it with a backend you control (e.g. self-hosted Langfuse or Phoenix).
