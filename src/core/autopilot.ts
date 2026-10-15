import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trace, type Span } from "@opentelemetry/api";
import { accountsAtStage, defaultRunner, runBatch, type ChunkRunner } from "./batch.ts";
import { claudeBilling, modelSpendIsBilled } from "./billing.ts";
import { readDoc } from "./frontmatter.ts";
import { currentRun, newRunId, spentForRun, type CurrentRun } from "./ledger.ts";
import type { Company } from "./schemas.ts";
import { rank } from "./scorefile.ts";
import { proposeShortlist } from "./shortlist.ts";
import { setAttrs, withSpan } from "./tracing.ts";
import { loadConfig, paths } from "./workspace.ts";

/**
 * Autopilot: runs the funnel end to end for one ICP — discover → light score → shortlist (gate) → research → score
 * (gate) → ways in → drafts (review) — as a small, resumable state machine. Every step is idempotent because the account files
 * hold the real state (stages, briefs, scores); autopilot.json only records progress, gates, attempts and spend.
 * It never passes a gate on its own and never sends anything.
 */

export const STEPS = ["discover", "enrich_light", "shortlist", "research", "score", "ways_in", "drafts"] as const;
export type StepId = (typeof STEPS)[number];
export type StepStatus = "pending" | "running" | "done" | "waiting" | "failed" | "skipped";

export interface StepState {
  id: StepId;
  status: StepStatus;
  attempts: number;
  started?: string;
  finished?: string;
  cost_usd?: number;
  summary?: string;
  error?: string;
}

export interface AutopilotState {
  run_id: string;
  icp: string;
  created: string;
  created_by?: string;
  budget_usd: number;
  target_candidates: number;
  until: StepId;
  status: "running" | "waiting" | "done" | "failed" | "aborted";
  /** kind: a human gate (default), a budget stop, or a plan usage-limit pause (resume needs no approval) */
  gate: { step: StepId; message: string; since: string; file?: string; kind?: "gate" | "budget" | "limit" } | null;
  steps: StepState[];
  updated: string;
}

export interface AutopilotDeps {
  /** headless session runner (discover) */
  session?: ChunkRunner;
  /** batch chunk runner (enrich/research/score/ways-in/drafts) */
  runner?: ChunkRunner;
  pluginRoot: string;
  log?: (line: string) => void;
  /** injectable wait for plan usage-limit resets (tests) */
  sleep?: (ms: number) => Promise<void>;
  /** retry backoff in ms per attempt (tests pass [0,0]) */
  backoffMs?: number[];
}

const statePath = (ws: string, icp: string, runId: string) => join(ws, "lists", icp, runId, "autopilot.json");
const lockPath = (ws: string) => join(ws, ".ase", "autopilot.lock");
const now = () => new Date().toISOString();

export function loadState(ws: string, icp: string, runId: string): AutopilotState {
  return JSON.parse(readFileSync(statePath(ws, icp, runId), "utf8")) as AutopilotState;
}

function save(ws: string, s: AutopilotState): void {
  s.updated = now();
  const p = statePath(ws, s.icp, s.run_id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
}

/** All autopilot runs in the workspace (newest first). */
export function listRuns(ws: string): AutopilotState[] {
  const out: AutopilotState[] = [];
  const lists = join(ws, "lists");
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name) : []);
  for (const icp of dirs(lists)) {
    for (const run of dirs(join(lists, icp))) {
      const p = statePath(ws, icp, run);
      if (existsSync(p)) out.push(JSON.parse(readFileSync(p, "utf8")) as AutopilotState);
    }
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

export function findRun(ws: string, runId?: string): AutopilotState | null {
  const runs = listRuns(ws);
  return runId ? (runs.find((r) => r.run_id === runId) ?? null) : (runs.find((r) => r.status === "running" || r.status === "waiting") ?? runs[0] ?? null);
}

function acquireLock(ws: string, runId: string): void {
  const p = lockPath(ws);
  if (existsSync(p)) {
    const held = JSON.parse(readFileSync(p, "utf8")) as { run_id: string; pid: number };
    let alive = false;
    try {
      process.kill(held.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && held.run_id !== runId) throw new Error(`autopilot run ${held.run_id} is already active in this workspace (pid ${held.pid})`);
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ run_id: runId, pid: process.pid, since: now() }));
}

function releaseLock(ws: string): void {
  if (existsSync(lockPath(ws))) rmSync(lockPath(ws));
}

/** The autopilot's budget lives in the ledger's active run, so every provider and model call counts against it. */
function ensureLedgerRun(ws: string, s: AutopilotState): CurrentRun {
  const run = currentRun(ws);
  if (run && run.run_id === s.run_id) return run;
  const r: CurrentRun = { run_id: s.run_id, stage: "autopilot", icp: s.icp, budget_usd: s.budget_usd, started: s.created, approved_by: s.created_by };
  mkdirSync(dirname(paths.currentRun(ws)), { recursive: true });
  writeFileSync(paths.currentRun(ws), JSON.stringify(r, null, 2));
  return r;
}

export async function startAutopilot(ws: string, opts: { icp: string; budgetUsd?: number; target?: number; until?: StepId; by?: string }): Promise<AutopilotState> {
  const cfg = await loadConfig(ws);
  if (opts.by && cfg.members.length && !cfg.members.some((m) => m.id === opts.by)) throw new Error(`"${opts.by}" is not a member in ase.config.yaml`);
  const icpFile = paths.icp(ws, opts.icp);
  if (!existsSync(icpFile)) throw new Error(`ICP ${opts.icp} does not exist`);
  const { data } = await readDoc<{ status?: string }>(icpFile);
  if (data.status !== "approved") throw new Error(`ICP ${opts.icp} is not approved (gate 1) — run icp-build first`);
  if (!existsSync(paths.scoring(ws, opts.icp))) throw new Error(`ICP ${opts.icp} has no scoring model — run scoring-design first`);
  // On a subscription Claude usage isn't billed, so the budget only caps Exa/Firecrawl and defaults from the config.
  const billing = claudeBilling(cfg.claude_billing);
  if (opts.budgetUsd === undefined && billing === "api") throw new Error("--budget is required: Claude is billed per token with your API key");
  const budgetUsd = opts.budgetUsd ?? cfg.budgets.per_run_usd;
  if (!(budgetUsd > 0)) throw new Error("--budget must be positive");
  const until = opts.until ?? "drafts";
  const s: AutopilotState = {
    run_id: newRunId("autopilot"), icp: opts.icp, created: now(), created_by: opts.by, budget_usd: budgetUsd,
    target_candidates: opts.target ?? 300, until, status: "running", gate: null,
    steps: STEPS.map((id) => ({ id, status: STEPS.indexOf(id) > STEPS.indexOf(until) ? "skipped" : "pending", attempts: 0 })),
    updated: now(),
  };
  save(ws, s);
  return s;
}

/** Approve the waiting gate (shortlist: approves the proposal file as ticked; drafts: marks review done). */
export async function approveGate(ws: string, s: AutopilotState, by: string): Promise<AutopilotState> {
  if (s.status !== "waiting" || !s.gate) throw new Error(`run ${s.run_id} is not waiting at a gate (status ${s.status})`);
  if (s.gate.step === "shortlist") {
    const { approveShortlist } = await import("./shortlist.ts");
    const r = await approveShortlist(ws, s.icp, s.gate.file!, by);
    const step = s.steps.find((x) => x.id === "shortlist")!;
    step.status = "done";
    step.finished = now();
    step.summary = `approved ${r.approved.length} accounts by ${by}`;
  } else {
    const step = s.steps.find((x) => x.id === s.gate!.step)!;
    step.status = "done";
    step.finished = now();
    step.summary = `${step.summary ?? ""} — reviewed by ${by}`.trim();
  }
  s.gate = null;
  s.status = "running";
  save(ws, s);
  return s;
}

/**
 * Continue a run further than it was started for (e.g. started with --until shortlist, now continue to score),
 * optionally with a new total budget. Skipped steps up to the new end become pending; finished work is kept.
 */
export function extendRun(ws: string, s: AutopilotState, opts: { until?: StepId; budgetUsd?: number; by?: string }): AutopilotState {
  if (s.status === "aborted") throw new Error(`run ${s.run_id} was aborted`);
  if (opts.until) {
    const end = STEPS.indexOf(opts.until);
    for (const st of s.steps) {
      const i = STEPS.indexOf(st.id);
      if (st.status === "skipped" && i <= end) st.status = "pending";
      if (st.status === "pending" && i > end) st.status = "skipped";
    }
    s.until = opts.until;
  }
  if (opts.budgetUsd !== undefined) {
    if (!(opts.budgetUsd > 0)) throw new Error("budget must be positive");
    s.budget_usd = opts.budgetUsd;
    const run = currentRun(ws);
    const r: CurrentRun = run && run.run_id === s.run_id ? { ...run, budget_usd: opts.budgetUsd, approved_by: opts.by ?? run.approved_by } : { run_id: s.run_id, stage: "autopilot", icp: s.icp, budget_usd: opts.budgetUsd, started: s.created, approved_by: opts.by };
    mkdirSync(dirname(paths.currentRun(ws)), { recursive: true });
    writeFileSync(paths.currentRun(ws), JSON.stringify(r, null, 2));
  }
  if (s.status === "done" && s.steps.some((x) => x.status === "pending")) s.status = "running";
  if (s.status === "waiting" && (s.gate?.kind === "budget" || s.gate?.message.startsWith("Budget")) && opts.budgetUsd) {
    s.gate = null;
    s.status = "running";
  }
  save(ws, s);
  return s;
}

/** Continue after a plan usage-limit pause. No approval needed: nothing was decided, the run just waited. */
export function resumeFromPause(ws: string, s: AutopilotState): AutopilotState {
  if (s.status !== "waiting" || s.gate?.kind !== "limit") return s;
  const step = s.steps.find((x) => x.id === s.gate!.step);
  if (step && step.status !== "done") step.status = "pending";
  s.gate = null;
  s.status = "running";
  save(ws, s);
  return s;
}

export function abortRun(ws: string, s: AutopilotState): AutopilotState {
  s.status = "aborted";
  save(ws, s);
  releaseLock(ws);
  return s;
}

async function shortlistedPending(ws: string, icp: string): Promise<string[]> {
  return accountsAtStage(ws, icp, "shortlisted");
}

async function tierAB(ws: string, icp: string, stage: string): Promise<string[]> {
  return (await rank(ws, icp, { stage })).filter((r) => r.tier === "A" || r.tier === "B").map((r) => r.domain);
}

async function withoutDrafts(ws: string, domains: string[]): Promise<string[]> {
  return domains.filter((d) => {
    const dir = join(ws, "accounts", d, "drafts");
    return !existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith(".md"));
  });
}

async function countAccounts(ws: string, icp: string): Promise<number> {
  const dir = join(ws, "accounts");
  let n = 0;
  for (const d of existsSync(dir) ? readdirSync(dir) : []) {
    const p = paths.company(ws, d);
    if (existsSync(p) && (await readDoc<Company>(p)).data.icp_status?.[icp]) n++;
  }
  return n;
}

/** Execute one step. Returns a summary, or a gate to wait at. Throws on failure (retried by the caller). */
async function execStep(ws: string, s: AutopilotState, id: StepId, deps: AutopilotDeps): Promise<{ summary: string; gate?: AutopilotState["gate"] }> {
  // A batch whose sessions crashed throws (→ retry, which only re-processes accounts that didn't advance).
  // Accounts a healthy session couldn't advance are reported in the summary instead of failing the run.
  const batch = async (skill: Parameters<typeof runBatch>[0]["skill"], domains?: string[]) => {
    const r = await runBatch({ ws, skill, icp: s.icp, pluginRoot: deps.pluginRoot, runner: deps.runner, domains, log: deps.log, sleep: deps.sleep });
    if (r.stopped?.startsWith("usage limit")) throw new Error(r.stopped);
    const crashed = r.results.filter((x) => !x.ok);
    if (crashed.length) throw new Error(`${crashed.length} ${skill} session(s) failed for ${crashed.flatMap((x) => x.domains).join(", ")}`);
    return r;
  };
  const stuck = (r: { not_advanced: string[] }) => (r.not_advanced.length ? `; not advanced: ${r.not_advanced.join(", ")}` : "");
  switch (id) {
    case "discover": {
      const have = await countAccounts(ws, s.icp);
      if (have >= s.target_candidates) return { summary: `skipped: ${have} candidates already (target ${s.target_candidates})` };
      const run = ensureLedgerRun(ws, s);
      const remaining = run.budget_usd - spentForRun(ws, run.run_id);
      const prompt = `/agentic-sales-engine:discover --icp ${s.icp} --target ${s.target_candidates - have} --unattended\n\nUnattended autopilot run ${s.run_id}: use the active ledger run, don't start or end runs, don't ask questions. Stop at the target or when queries saturate.`;
      const billing = claudeBilling((await loadConfig(ws)).claude_billing);
      const r = await (deps.session ?? defaultRunner(billing))({ ws, prompt, model: (await loadConfig(ws)).models.discover, maxBudgetUsd: Math.max(0.1, Math.min(remaining * 0.25, 5)), pluginRoot: deps.pluginRoot, span: trace.getActiveSpan() });
      const { appendLedger } = await import("./ledger.ts");
      appendLedger(ws, { run_id: s.run_id, provider: "anthropic", op: "autopilot:discover", usd: r.cost_usd, kind: "actual", ...(modelSpendIsBilled(billing) ? {} : { billed: false }) });
      if (r.limit?.limited) throw new Error(`usage limit: Claude plan usage limit reached${r.limit.resetsAt ? `, resets ${new Date(r.limit.resetsAt).toISOString()}` : ""}`);
      if (!r.ok) throw new Error(`discover session did not succeed: ${r.summary.slice(0, 200)}`);
      return { summary: `${(await countAccounts(ws, s.icp)) - have} new candidates` };
    }
    case "enrich_light": {
      const todo = await accountsAtStage(ws, s.icp, "discovered");
      if (!todo.length) return { summary: "nothing to enrich" };
      const r = await batch("enrich-light");
      if (r.stopped) throw new Error(r.stopped);
      return { summary: `${r.advanced}/${r.processed} light-scored${stuck(r)}` };
    }
    case "shortlist": {
      const already = await shortlistedPending(ws, s.icp);
      const pool = await accountsAtStage(ws, s.icp, "light_scored");
      if (!pool.length) return { summary: already.length ? `${already.length} already shortlisted` : "no light-scored accounts to shortlist" };
      const p = await proposeShortlist(ws, s.icp);
      return {
        summary: `proposed ${p.picked.length} of ${p.pool} (≈ $${p.cost.total_p50}–${p.cost.total_p90})`,
        gate: { step: "shortlist", since: now(), file: p.path, message: `GATE 2: review ${p.path} (${p.picked.length} accounts, ≈ $${p.cost.total_p50}–${p.cost.total_p90}) and approve: ase autopilot approve --by <member>` },
      };
    }
    case "research": {
      const todo = await shortlistedPending(ws, s.icp);
      if (!todo.length) return { summary: "nothing to research" };
      const r = await batch("research", todo);
      if (r.stopped) throw new Error(r.stopped);
      return { summary: `${r.advanced}/${r.processed} researched${stuck(r)}` };
    }
    case "score": {
      const todo = await accountsAtStage(ws, s.icp, "researched");
      let summary = "nothing left to score";
      if (todo.length) {
        const r = await batch("score", todo);
        summary = `${r.advanced}/${r.processed} scored${stuck(r)}`;
      }
      // GATE: a human reviews the full scores before any ways-in or outreach work is spent on them.
      const scored = await rank(ws, s.icp, { stage: "scored" });
      if (!scored.length) return { summary };
      const tiers = ["A", "B", "C", "X"].map((t) => `${scored.filter((x) => x.tier === t).length} ${t}`).join(" · ");
      return {
        summary: `${summary}; ${scored.length} scored: ${tiers}`,
        gate: { step: "score", since: now(), message: `Review the full scores (ase score rank --icp ${s.icp} --stage scored; score --explain <domain>) — ${tiers}. Ways in and drafts run for tier A/B after: ase autopilot approve --by <member> --resume` },
      };
    }
    case "ways_in": {
      const todo = await tierAB(ws, s.icp, "scored");
      if (!todo.length) return { summary: "no tier A/B accounts to find ways in for" };
      const r = await batch("ways-in", todo);
      return { summary: `${r.advanced}/${r.processed} outreach-ready${stuck(r)}` };
    }
    case "drafts": {
      const todo = await withoutDrafts(ws, await tierAB(ws, s.icp, "outreach_ready"));
      if (!todo.length) return { summary: "no accounts need drafts" };
      const r = await batch("draft-outreach", todo);
      const drafted = (await withoutDrafts(ws, todo)).length;
      return {
        summary: `drafted for ${todo.length - drafted}/${todo.length} accounts`,
        gate: { step: "drafts", since: now(), message: `Review the drafts (ase drafts list --status draft), edit, send yourself, then: ase autopilot approve --by <member>` },
      };
    }
  }
}

/** Advance the run until it finishes, fails, or waits at a gate. Safe to call repeatedly (resume). */
export async function advance(ws: string, s0: AutopilotState, deps: AutopilotDeps): Promise<AutopilotState> {
  let s = s0;
  if (s.status === "done" || s.status === "aborted") return s;
  if (s.status === "waiting") return s;
  const log = deps.log ?? (() => {});
  const backoff = deps.backoffMs ?? [5_000, 30_000];
  acquireLock(ws, s.run_id);
  try {
    return await withSpan("autopilot.run", { "ase.run_id": s.run_id, "ase.icp": s.icp, "ase.budget_usd": s.budget_usd }, async (runSpan: Span) => {
      ensureLedgerRun(ws, s);
      for (const step of s.steps) {
        if (step.status === "done" || step.status === "skipped") continue;
        if (step.status === "waiting") {
          s.status = "waiting";
          break;
        }
        const spent = spentForRun(ws, s.run_id);
        if (spent >= s.budget_usd - 0.01) {
          s.status = "waiting";
          s.gate = { step: step.id, kind: "budget", since: now(), message: `Budget used ($${spent.toFixed(2)} of $${s.budget_usd}). Raise it with: ase ledger run extend --budget <usd> --approved-by <member>, then ase autopilot resume` };
          break;
        }
        step.status = "running";
        step.started ??= now();
        save(ws, s);
        log(`[autopilot ${s.run_id}] ${step.id}…`);
        const before = spentForRun(ws, s.run_id);
        let result: Awaited<ReturnType<typeof execStep>> | null = null;
        while (!result && step.status === "running") {
          step.attempts++;
          try {
            result = await withSpan(`autopilot.step.${step.id}`, { "ase.attempt": step.attempts }, () => execStep(ws, s, step.id, deps));
          } catch (e) {
            step.error = (e as Error).message.slice(0, 500);
            log(`[autopilot ${s.run_id}] ${step.id} attempt ${step.attempts} failed: ${step.error}`);
            const limitHit = /^usage limit/i.test(step.error);
            const budgetHit = !limitHit && /budget/i.test(step.error);
            if (limitHit || budgetHit || step.attempts > backoff.length) {
              step.status = limitHit || budgetHit ? "pending" : "failed";
              s.status = limitHit || budgetHit ? "waiting" : "failed";
              if (limitHit) step.attempts = 0;
              if (limitHit) s.gate = { step: step.id, kind: "limit", since: now(), message: `Paused at ${step.id}: ${step.error.replace(/^usage limit: /, "")}. Nothing is lost — continue after the reset with: ase autopilot resume` };
              if (budgetHit) s.gate = { step: step.id, kind: "budget", since: now(), message: `Budget reached during ${step.id}. Extend with ase ledger run extend --budget <usd> --approved-by <member>, then ase autopilot resume` };
            } else {
              save(ws, s);
              await new Promise((r) => setTimeout(r, backoff[step.attempts - 1]));
            }
          }
        }
        step.cost_usd = Math.round(((step.cost_usd ?? 0) + spentForRun(ws, s.run_id) - before) * 10000) / 10000;
        if (!result) {
          save(ws, s);
          break;
        }
        step.summary = result.summary;
        step.error = undefined;
        if (result.gate) {
          step.status = "waiting";
          s.gate = result.gate;
          s.status = "waiting";
          save(ws, s);
          log(`[autopilot ${s.run_id}] waiting: ${result.gate.message}`);
          break;
        }
        step.status = "done";
        step.finished = now();
        save(ws, s);
        log(`[autopilot ${s.run_id}] ${step.id}: ${result.summary}`);
      }
      if (s.status === "running" && s.steps.every((x) => x.status === "done" || x.status === "skipped")) s.status = "done";
      setAttrs(runSpan, { "ase.status": s.status, "ase.spent_usd": spentForRun(ws, s.run_id), "ase.gate": s.gate?.step ?? null });
      save(ws, s);
      return s;
    });
  } finally {
    if (s.status !== "running") releaseLock(ws);
  }
}
