#!/usr/bin/env bun
/**
 * Claude Managed Agents runs for the owner's own use (see docs/managed-agents.md).
 *   bun src/managed/cli.ts sync                       agents/*.md → versioned managed agents (+ environment, vault)
 *   bun src/managed/cli.ts run --repo owner/name --icp <s> <domain...> [--base master] [--budget 1.2] [--cap 5] [--approved-by hein]
 *   bun src/managed/cli.ts telemetry                   send the platform's traces to Braintrust (needs an Admin key once)
 *   bun src/managed/cli.ts status                      what exists on the platform
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connectTelemetry, managedState, run, sync } from "./platform.ts";

const ROOT = join(import.meta.dir, "../..");
const { values: f, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { repo: { type: "string" }, icp: { type: "string" }, base: { type: "string" }, budget: { type: "string" }, cap: { type: "string" }, "approved-by": { type: "string" } },
});
const [cmd, ...rest] = positionals;
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

try {
  if (cmd === "sync") out(await sync(ROOT));
  else if (cmd === "status") out(managedState());
  else if (cmd === "telemetry") out(await connectTelemetry());
  else if (cmd === "run") {
    if (!f.repo || !f.icp || !rest.length) throw new Error("usage: run --repo owner/name --icp <slug> <domain...>");
    const r = await run({ pluginRoot: ROOT, repo: f.repo, baseBranch: f.base ?? "master", icp: f.icp, domains: rest, budgetUsd: Number(f.budget ?? 1.2), capUsd: Number(f.cap ?? 5), approvedBy: f["approved-by"] ?? "hein" });
    out(r);
    if (r.status !== "end_turn") process.exitCode = 2;
  } else throw new Error("usage: sync | run | telemetry | status");
} catch (e) {
  console.error(`managed: ${(e as Error).message}`);
  process.exit(1);
}
