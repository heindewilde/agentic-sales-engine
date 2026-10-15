# Observability: Langfuse, LangSmith, or any OpenTelemetry backend

Pick the tool you like, or several at once to compare them. **One command connects it**, and from then on:

- **traces** of every run (batch, autopilot, headless sessions, provider calls, scoring) go there,
- **eval scores** go there with `ase eval run --push` (each score attached to the eval run),
- **datasets** go there with `ase dataset push`. Each account becomes an input/expected-output pair you can run
  experiments against.

## Connect

```bash
# Langfuse (open source; cloud or self-hosted) — public and secret key from Project settings → API keys
pbpaste | ase observability connect langfuse                              # EU cloud (default)
pbpaste | ase observability connect langfuse --host https://us.cloud.langfuse.com
pbpaste | ase observability connect langfuse --host https://langfuse.mycompany.com   # self-hosted
#   clipboard contents: pk-lf-…:sk-lf-…

# LangSmith — API key from Settings → API keys
pbpaste | ase observability connect langsmith --project sales-engine
pbpaste | ase observability connect langsmith --endpoint https://eu.api.smith.langchain.com

ase observability status          # what's connected, with a live check
ase observability disconnect langsmith
```

Keys are read from stdin, so they never appear on a command line or in shell history. They're stored in
`~/.config/agentic-sales-engine/credentials.env` (mode 600), never in a repository. Each `connect` verifies the keys
against the tool's API and tells you whether it worked.

Any other OTLP backend (Phoenix, Jaeger, Honeycomb, Grafana…) works through the standard variables, which can live
in the same credentials file: `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (see [tracing.md](tracing.md)).

## Use

```bash
ase eval run --push                               # offline evals → scores in every connected tool
ase eval run --suite llm --push --experiment v12  # Claude-as-judge evals, labelled as an experiment
ase dataset push --icp <slug> --mode full         # accounts as a dataset (name: ase-<icp>-full)
bun bench/run.ts --label my-change --push         # the fixed benchmark, scores pushed as experiment "my-change"
```

Connect both tools to compare them: traces, scores and datasets go to each, identically.

## How it maps

| | Langfuse | LangSmith |
|---|---|---|
| Traces | OTLP → `<host>/api/public/otel/v1/traces` (Basic auth) | OTLP → `<endpoint>/otel/v1/traces` (`x-api-key`, `Langsmith-Project`) |
| Eval scores | `POST /api/public/scores` on the eval run's trace (Langfuse uses the OTel trace id) | an `eval.<suite>` run created via `POST /api/v1/runs`, scores as feedback (LangSmith can't link OTel span ids to runs) |
| Datasets | `POST /api/public/v2/datasets` + `/api/public/dataset-items` | `POST /api/v1/datasets` + `/api/v1/examples` |
| Re-pushing | stable ids → updates, no duplicates | stable UUIDs → no duplicates |

## Add another tool

Implement the `Backend` interface in `src/observability/backends.ts`: `otlp`, `verify`, `pushScores` and
`pushDataset`. Add it to `BACKENDS` and to the credential keys. The CLI, tracing and benchmark pick it up automatically.

## Privacy

Traces carry metadata only (operations, domains, costs, durations, outcomes) unless `ASE_TRACE_CONTENT=1`. Datasets
contain account context and expected outputs: company facts and brief snapshots, plus business-relevant people data
if present. Only push datasets to a tool you're allowed to share that data with. A self-hosted Langfuse keeps
everything on your own infrastructure.
