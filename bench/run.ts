#!/usr/bin/env bun
/** Cost/quality benchmark — see bench/README.md. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { persistCandidates } from "../src/core/accounts.ts";
import { runBatch } from "../src/core/batch.ts";
import { loadCredentials } from "../src/core/credentials.ts";
import { readSeedCsv } from "../src/core/importers.ts";
import { readLedger } from "../src/core/ledger.ts";
import { approveShortlist } from "../src/core/shortlist.ts";
import { initTracing, shutdownTracing } from "../src/core/tracing.ts";
import { runLlm } from "../src/evals/llm.ts";
import { runOffline } from "../src/evals/offline.ts";
import { stringifyDoc } from "../src/core/frontmatter.ts";

const ROOT = join(import.meta.dir, "..");
const ICP = "ap-automation-midmarket";
// 5 researched accounts: enough to measure light-vs-full agreement (needs ≥ 5)
const RESEARCH = ["boma.eu", "vanegmond.nl", "hanos.nl", "edco.nl", "foox.nl"];
const { values: f } = parseArgs({ args: process.argv.slice(2), options: { label: { type: "string" }, compare: { type: "string" }, push: { type: "boolean" } } });

if (f.compare) {
  const [a, b] = f.compare.split(",").map((l) => JSON.parse(readFileSync(join(ROOT, "bench/results", `${l}.json`), "utf8")));
  const pct = (x: number, y: number) => (x ? `${(((y - x) / x) * 100).toFixed(0)}%` : "n/a");
  console.log(`${"metric".padEnd(34)} ${a.label.padStart(12)} ${b.label.padStart(12)}   change`);
  const row = (k: string, x: number, y: number, fmt = (n: number) => n.toFixed(3)) => console.log(`${k.padEnd(34)} ${fmt(x).padStart(12)} ${fmt(y).padStart(12)}   ${pct(x, y)}`);
  for (const k of Object.keys(a.cost)) row(`cost ${k} ($)`, a.cost[k], b.cost[k] ?? 0);
  for (const k of Object.keys(a.sessions)) {
    row(`turns ${k}`, a.sessions[k].turns, b.sessions[k]?.turns ?? 0, (n) => String(n));
    row(`output tokens ${k}`, a.sessions[k].output_tokens, b.sessions[k]?.output_tokens ?? 0, (n) => String(n));
  }
  for (const k of Object.keys(a.quality)) row(`quality ${k}`, a.quality[k] ?? 0, b.quality[k] ?? 0, (n) => n.toFixed(2));
  row("advanced light", a.advanced.light, b.advanced.light, String);
  row("advanced research", a.advanced.research, b.advanced.research, String);
  process.exit(0);
}

const label = f.label ?? "run";
const ws = join(mkdtempSync(join(tmpdir(), `ase-bench-${label}-`)), "ws");
cpSync(join(ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
for (const p of ["accounts", "people", "raw"]) rmSync(join(ws, p), { recursive: true, force: true });
mkdirSync(join(ws, "imports/seeds"), { recursive: true });
cpSync(join(ROOT, "bench/seeds.csv"), join(ws, "imports/seeds/bench.csv"));
loadCredentials(ws);
const spans = new InMemorySpanExporter();
initTracing("bench", { exporter: spans });
const log = (l: string) => process.stderr.write(`${l}\n`);

const { candidates } = readSeedCsv(ws, join(ws, "imports/seeds/bench.csv"));
await persistCandidates(ws, ICP, "bench", "import:imports/seeds/bench.csv", candidates);

log("light enrich…");
const light = await runBatch({ ws, skill: "enrich-light", icp: ICP, pluginRoot: ROOT, budgetUsd: 3, chunk: 10, log });
rmSync(join(ws, ".ase", "current-run.json"), { force: true }); // research gets its own run budget

// fixed shortlist: approve exactly the two research accounts (whatever their light score)
const sl = `lists/${ICP}/bench/shortlist.md`;
mkdirSync(join(ws, `lists/${ICP}/bench`), { recursive: true });
writeFileSync(join(ws, sl), stringifyDoc({ icp: ICP, run_id: "bench", status: "proposed", cost: { per_account_p90: 1 } }, `| Research | Domain |\n|---|---|\n${RESEARCH.map((d) => `| [x] | ${d} |`).join("\n")}\n`));
const appr = await approveShortlist(ws, ICP, sl, "hein");
log(`approved ${appr.approved.join(", ")} (skipped ${JSON.stringify(appr.skipped)})`);

log("research…");
const research = await runBatch({ ws, skill: "research", icp: ICP, pluginRoot: ROOT, budgetUsd: 4, domains: appr.approved, log });

log("evals…");
const offline = await runOffline(ws);
const llm = await runLlm(ws, { budgetUsd: 0.6, sample: 2 });
const finished = spans.getFinishedSpans(); // read before shutdown: shutting down clears the in-memory exporter
await shutdownTracing();

const ledger = readLedger(ws);
const sum = (pred: (e: (typeof ledger)[number]) => boolean) => Math.round(ledger.filter(pred).reduce((a, e) => a + e.usd, 0) * 10000) / 10000;
const chunks = finished.filter((s) => s.name === "batch.chunk");
const sess = (skill: string) => {
  const cs = chunks.filter((c) => c.attributes["ase.skill"] === skill);
  return { sessions: cs.length, turns: cs.reduce((a, c) => a + Number(c.attributes["ase.turns"] ?? 0), 0), output_tokens: cs.reduce((a, c) => a + Number(c.attributes["gen_ai.usage.output_tokens"] ?? 0), 0) };
};
const result = {
  label, ran_at: new Date().toISOString(), workspace: ws,
  cost: {
    light_model: sum((e) => e.op === "batch:enrich-light"),
    research_model: sum((e) => e.op === "batch:research"),
    providers: sum((e) => e.provider === "exa" || e.provider === "firecrawl"),
    total_pipeline: sum((e) => e.op !== "eval:llm"),
    per_light_account: Math.round((sum((e) => e.op === "batch:enrich-light") / 10) * 10000) / 10000,
    per_research_account: Math.round((sum((e) => e.op === "batch:research") / Math.max(1, appr.approved.length)) * 10000) / 10000,
  },
  sessions: { light: sess("enrich-light"), research: sess("research") },
  advanced: { light: light.advanced, research: research.advanced },
  quality: Object.fromEntries([...Object.entries(offline.summary), ...Object.entries(llm.summary)].map(([k, v]) => [k, v.mean])),
};
// --push: send both suites to every connected observability backend as experiment "<label>"
if (f.push) {
  const { connectedBackends } = await import("../src/observability/backends.ts");
  for (const b of connectedBackends()) {
    for (const s of [offline, llm]) log(`${b.id}: ${JSON.stringify(await b.pushScores(process.env, s, { experiment: label }).catch((e) => ({ error: (e as Error).message })))}`);
  }
}
mkdirSync(join(ROOT, "bench/results"), { recursive: true });
writeFileSync(join(ROOT, "bench/results", `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
log(`workspace kept at ${ws} for inspection`);
