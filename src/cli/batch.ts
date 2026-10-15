#!/usr/bin/env bun
/**
 * Batch driver — runs a stage skill over many accounts in headless Claude sessions (`claude -p` on a subscription, Agent SDK with an API key).
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts --skill enrich-light --icp <slug> [--budget 5] [--chunk 10]
 *       [--concurrency 3] [--model haiku] [--limit N] [--domains a.com,b.com] [--dry-run]
 * Provider keys for headless runs come from EXA_API_KEY / FIRECRAWL_API_KEY in the environment or a
 * workspace .env. Claude authentication is your normal Claude Code login (or ANTHROPIC_API_KEY).
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BATCH_SKILLS, runBatch, type BatchSkill } from "../core/batch.ts";
import { requireWorkspace } from "../core/workspace.ts";
import { loadCredentials } from "../core/credentials.ts";
import { initTracing, shutdownTracing } from "../core/tracing.ts";

const { values: f } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    skill: { type: "string" },
    icp: { type: "string" },
    budget: { type: "string" },
    chunk: { type: "string" },
    concurrency: { type: "string" },
    model: { type: "string" },
    limit: { type: "string" },
    domains: { type: "string" },
    "dry-run": { type: "boolean" },
    workspace: { type: "string" },
  },
});

const skill = f.skill as BatchSkill;
if (!skill || !(skill in BATCH_SKILLS) || !f.icp) {
  process.stderr.write(`usage: batch.ts --skill <${Object.keys(BATCH_SKILLS).join("|")}> --icp <slug> [options]\n`);
  process.exit(1);
}
const ws = requireWorkspace(f.workspace);
loadCredentials(ws);
initTracing("batch");
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const res = await runBatch({
  ws,
  skill,
  icp: f.icp,
  pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, "..", ".."),
  budgetUsd: num(f.budget),
  chunk: num(f.chunk),
  concurrency: num(f.concurrency),
  model: f.model,
  limit: num(f.limit),
  domains: f.domains?.split(",").map((d) => d.trim()).filter(Boolean),
  dryRun: f["dry-run"],
});
process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
await shutdownTracing();
