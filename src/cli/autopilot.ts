#!/usr/bin/env bun
/**
 * Autopilot — run the funnel end to end for one ICP, pausing at the human gates.
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/autopilot.ts start --icp <slug> [--budget <usd>, required with an API key] [--target 300] [--until drafts] [--by <member>]
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/autopilot.ts status|resume|abort [<run-id>]
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/autopilot.ts approve [<run-id>] --by <member> [--resume]
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/autopilot.ts extend [<run-id>] [--until <step>] [--budget <usd>] --by <member> [--resume]
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/autopilot.ts list
 * Long-running: start/resume run until the next gate, the end, or a failure. Safe to re-run (resume).
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { abortRun, advance, approveGate, extendRun, findRun, listRuns, resumeFromPause, startAutopilot, STEPS, type AutopilotState, type StepId } from "../core/autopilot.ts";
import { loadCredentials } from "../core/credentials.ts";
import { claudeBilling } from "../core/billing.ts";
import { readLedger, spentForRun, subscriptionUsage } from "../core/ledger.ts";
import { loadConfig } from "../core/workspace.ts";
import { initTracing, shutdownTracing } from "../core/tracing.ts";
import { requireWorkspace } from "../core/workspace.ts";

const { values: f, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    icp: { type: "string" },
    budget: { type: "string" },
    target: { type: "string" },
    until: { type: "string" },
    by: { type: "string" },
    resume: { type: "boolean" },
    workspace: { type: "string" },
    text: { type: "boolean" },
  },
});

const [cmd, runId] = positionals;
const ws = requireWorkspace(f.workspace);
loadCredentials(ws);
initTracing("autopilot");
const deps = { pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, "..", ".."), log: (l: string) => process.stderr.write(`${l}\n`) };

const billing = claudeBilling((await loadConfig(ws).catch(() => null))?.claude_billing);
function spendLine(s: AutopilotState): string {
  const spent = `$${spentForRun(ws, s.run_id).toFixed(2)} of $${s.budget_usd}`;
  if (billing === "api") return `spent ${spent}`;
  const usage = subscriptionUsage(readLedger(ws).filter((e) => e.run_id === s.run_id));
  return `providers ${spent} · Claude on your subscription (≈ $${usage.toFixed(2)} API-equivalent)`;
}
function show(s: AutopilotState): string {
  const icon: Record<string, string> = { done: "✓", running: "…", waiting: "⏸", failed: "✗", pending: "·", skipped: "–" };
  const lines = [`autopilot ${s.run_id} · ${s.icp} · ${s.status} · ${spendLine(s)}`];
  for (const st of s.steps) lines.push(`  ${icon[st.status]} ${st.id.padEnd(13)} ${st.summary ?? ""}${st.error && st.status !== "done" ? `  [${st.error.slice(0, 100)}]` : ""}${st.cost_usd ? `  ($${st.cost_usd.toFixed(2)})` : ""}`);
  if (s.gate) lines.push("", s.gate.message);
  return lines.join("\n");
}
const out = (s: AutopilotState) => process.stdout.write(`${f.text ? show(s) : JSON.stringify({ ...s, spent_usd: spentForRun(ws, s.run_id), view: show(s) }, null, 2)}\n`);
const fail = (m: string): never => {
  process.stderr.write(`autopilot: ${m}\n`);
  process.exit(1);
};

try {
  switch (cmd) {
    case "start": {
      const until = (f.until ?? "drafts") as StepId;
      if (!STEPS.includes(until)) fail(`--until must be one of ${STEPS.join(", ")}`);
      const s = await startAutopilot(ws, { icp: f.icp ?? fail("--icp is required"), budgetUsd: f.budget ? Number(f.budget) : undefined, target: f.target ? Number(f.target) : undefined, until, by: f.by });
      out(await advance(ws, s, deps));
      break;
    }
    case "resume": {
      const s = resumeFromPause(ws, findRun(ws, runId) ?? fail("no autopilot run found"));
      if (s.status === "failed") {
        // a failed step gets a fresh set of attempts on resume
        for (const st of s.steps) if (st.status === "failed") (st.status = "pending"), (st.attempts = 0);
        s.status = "running";
      }
      out(await advance(ws, s, deps));
      break;
    }
    case "approve": {
      const s = findRun(ws, runId) ?? fail("no autopilot run found");
      const approved = await approveGate(ws, s, f.by ?? fail("--by <member> is required: approving a gate is a human decision"));
      out(f.resume ? await advance(ws, approved, deps) : approved);
      break;
    }
    case "extend": {
      const s = findRun(ws, runId) ?? fail("no autopilot run found");
      const until = f.until as StepId | undefined;
      if (until && !STEPS.includes(until)) fail(`--until must be one of ${STEPS.join(", ")}`);
      if (f.budget && !f.by) fail("--by <member> is required to change the budget");
      const e = extendRun(ws, s, { until, budgetUsd: f.budget ? Number(f.budget) : undefined, by: f.by });
      out(f.resume ? await advance(ws, e, deps) : e);
      break;
    }
    case "abort":
      out(abortRun(ws, findRun(ws, runId) ?? fail("no autopilot run found")));
      break;
    case "list":
      process.stdout.write(`${JSON.stringify(listRuns(ws).map((r) => ({ run_id: r.run_id, icp: r.icp, status: r.status, gate: r.gate?.step ?? null, updated: r.updated })), null, 2)}\n`);
      break;
    case "status":
    default: {
      const s = findRun(ws, cmd === "status" ? runId : undefined) ?? fail("no autopilot run found");
      out(s);
    }
  }
} catch (e) {
  fail((e as Error).message);
} finally {
  await shutdownTracing();
}
