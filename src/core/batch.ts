import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reindexAll } from "./db.ts";
import { readDoc } from "./frontmatter.ts";
import { claudeBilling, modelSpendIsBilled, type ClaudeBilling } from "./billing.ts";
import { allowedTools, askOnce, cliRunner, MODEL_ALIASES, sessionEnv, streamCollector } from "./headless.ts";
import { waitMs, type LimitState } from "./limits.ts";
import { appendLedger, currentRun, newRunId, spentForRun, type CurrentRun } from "./ledger.ts";
import type { Company } from "./schemas.ts";
import { loadConfig, paths } from "./workspace.ts";
import type { Span } from "@opentelemetry/api";
import { setAttrs, startSpan, withSpan } from "./tracing.ts";

/**
 * Batch driver: runs a stage skill over many accounts in chunks, each chunk in its own headless Claude
 * session (Agent SDK) with the plugin loaded — so hooks, the provider gateway and budgets all apply —
 * and with bounded concurrency. Resumable: accounts are selected by stage, and a processed account moves on.
 */

export const BATCH_SKILLS = {
  "enrich-light": { fromStage: "discovered", toStage: "light_scored", defaultModel: "light" as const, defaultChunk: 10 },
  // two accounts per session halves the fixed start-up cost per account
  research: { fromStage: "shortlisted", toStage: "researched", defaultModel: "research" as const, defaultChunk: 2 },
  score: { fromStage: "researched", toStage: "scored", defaultModel: "research" as const, defaultChunk: 5 },
  "ways-in": { fromStage: "scored", toStage: "outreach_ready", defaultModel: "ways_in" as const, defaultChunk: 5 },
  // drafts don't move the stage; progress is measured by draft files (see autopilot)
  "draft-outreach": { fromStage: "outreach_ready", toStage: "outreach_ready", defaultModel: "drafts" as const, defaultChunk: 3 },
} as const;
export type BatchSkill = keyof typeof BATCH_SKILLS;

export interface ChunkRunResult {
  cost_usd: number;
  ok: boolean;
  summary: string;
  denied?: string[];
  /** set when a plan usage limit stopped the session, or it started using paid extra usage */
  limit?: LimitState;
}

export interface ChunkRunner {
  (args: { ws: string; prompt: string; model: string; maxBudgetUsd: number; pluginRoot: string; span?: Span }): Promise<ChunkRunResult>;
}

export interface BatchOptions {
  ws: string;
  skill: BatchSkill;
  icp: string;
  pluginRoot: string;
  chunk?: number;
  concurrency?: number;
  budgetUsd?: number;
  model?: string;
  limit?: number;
  domains?: string[];
  dryRun?: boolean;
  runner?: ChunkRunner;
  /** injectable for tests (usage-limit waits) */
  sleep?: (ms: number) => Promise<void>;
  /** one-shot judge for the second opinion (tests); default: claude -p / Agent SDK by billing */
  ask?: (prompt: string, opts: { model: string }) => Promise<{ text: string; cost_usd: number }>;
  skipReconcile?: boolean;
  log?: (line: string) => void;
}

export async function accountsAtStage(ws: string, icp: string, stage: string): Promise<string[]> {
  const dir = join(ws, "accounts");
  const out: string[] = [];
  for (const d of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const p = paths.company(ws, d);
    if (!existsSync(p)) continue;
    const { data } = await readDoc<Company>(p);
    if (!data.dnc && data.icp_status?.[icp]?.stage === stage) out.push(d);
  }
  return out;
}

/** Appended to every batch prompt: what this headless session may do, so a denied command isn't misread. */
export const UNATTENDED_NOTE = (root: string) =>
  [
    "Unattended batch session — no human is watching, so don't ask questions; finish what you can and summarize.",
    `Permissions: Read, Write, Edit, Glob, Grep, WebFetch/WebSearch, the ase MCP tools, and Bash ONLY for \`bun ${root}/src/cli/ase.ts <command>\` (one command per call, no pipes, no cd, no &&).`,
    "Use Glob/Read/Grep to explore files (not ls/find/cat). Write judgement JSON with the Write tool to .ase/tmp/<domain>-<mode>.json (never inside accounts/), then pass it with --judgements <file>.",
    "If one command is denied, the rest of the toolset still works — adjust and continue.",
    "The batch driver owns the ledger run and its budget: never run `ase ledger run start|end|extend` in this session.",
    `Work through the fast path: \`bun ${root}/src/cli/ase.ts context …\` once, then ONE \`ase apply\` JSON — don't read or write account files one by one, and don't spawn agents.`,
    "Final reply: at most 3 short lines (counts, notable exclusions, anything that failed). Nobody reads more.",
  ].join("\n");

/** Agent SDK runner: one session per chunk. Used with an API key (servers, CI); see headless.ts. */
export const sdkRunner: ChunkRunner = async ({ ws, prompt, model, maxBudgetUsd, pluginRoot, span }) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const c = streamCollector(span);
  for await (const m of query({
    prompt,
    options: {
      cwd: ws,
      model: MODEL_ALIASES[model] ?? model,
      plugins: [{ type: "local", path: pluginRoot }],
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: allowedTools(pluginRoot),
      maxBudgetUsd,
      maxTurns: 200,
      env: sessionEnv(span),
    },
  })) c.add(m as unknown as Record<string, unknown>);
  return c.finish();
};

/**
 * Which transport runs headless sessions: `claude -p` on a subscription (Claude Code's own headless mode, on your
 * login), the Agent SDK with an API key. ASE_HEADLESS=cli|sdk overrides.
 */
export function defaultRunner(billing: ClaudeBilling = claudeBilling()): ChunkRunner {
  const forced = process.env.ASE_HEADLESS;
  if (forced === "sdk") return sdkRunner;
  if (forced === "cli") return cliRunner;
  return billing === "api" ? sdkRunner : cliRunner;
}

async function pool<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

export async function runBatch(o: BatchOptions) {
  return withSpan("batch.run", { "ase.skill": o.skill, "ase.icp": o.icp, "ase.dry_run": Boolean(o.dryRun) }, (runSpan) => runBatchInner(o, runSpan));
}

async function runBatchInner(o: BatchOptions, runSpan: Span) {
  const spec = BATCH_SKILLS[o.skill];
  const cfg = await loadConfig(o.ws);
  const log = o.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  let domains = o.domains ?? (await accountsAtStage(o.ws, o.icp, spec.fromStage));
  if (o.limit) domains = domains.slice(0, o.limit);
  const chunkSize = o.chunk ?? spec.defaultChunk;
  const chunks: string[][] = [];
  for (let i = 0; i < domains.length; i += chunkSize) chunks.push(domains.slice(i, i + chunkSize));
  const model = o.model ?? cfg.models[spec.defaultModel];
  const billing = claudeBilling(cfg.claude_billing);
  const runner = o.runner ?? defaultRunner(billing);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));

  // Reuse the active run (e.g. the budget approved at GATE 2) or start one.
  let run: CurrentRun | null = currentRun(o.ws);
  if (!run || run.icp !== o.icp) {
    run = { run_id: newRunId(o.skill), stage: o.skill, icp: o.icp, budget_usd: o.budgetUsd ?? cfg.budgets.per_run_usd, started: new Date().toISOString() };
    if (!o.dryRun) {
      mkdirSync(dirname(paths.currentRun(o.ws)), { recursive: true });
      writeFileSync(paths.currentRun(o.ws), JSON.stringify(run, null, 2));
    }
  }
  const plan = { run_id: run.run_id, skill: o.skill, icp: o.icp, model, accounts: domains.length, chunks: chunks.length, chunk_size: chunkSize, budget_usd: run.budget_usd, claude_billing: billing };
  type ChunkResult = { chunk: number; domains: string[]; ok: boolean; cost_usd: number; advanced: string[] };
  const empty = { processed: 0, advanced: 0, not_advanced: [] as string[], spent_usd: 0, stopped: null as string | null, second_opinion: null as { accounts: number; changed: number; disputed: number } | null, usage_limit: null as { resets_at: string | null; overage: boolean } | null, log: null as string | null, results: [] as ChunkResult[] };
  if (o.dryRun || chunks.length === 0) return { ...plan, dry_run: Boolean(o.dryRun), ...empty };

  const logFile = join(o.ws, "lists", o.icp, run.run_id, `batch-${o.skill}.md`);
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `# Batch ${o.skill} — ${o.icp} — ${new Date().toISOString()}\n\nmodel ${model}, ${domains.length} accounts in ${chunks.length} chunks, budget $${run.budget_usd}\n\n`);

  const results: ChunkResult[] = [];
  let stopped: string | null = null;
  let usageLimit: LimitState | null = null;
  let pausedUntil = 0;
  let limitAttempts = 0;
  const maxWait = cfg.usage_limits.max_wait_minutes * 60_000;
  await pool(chunks, o.concurrency ?? 3, async (chunk, i) => {
    if (stopped) return;
    if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now()); // another chunk hit a plan limit
    if (stopped) return;
    const spent = spentForRun(o.ws, run!.run_id);
    const remaining = run!.budget_usd - spent;
    if (remaining <= 0.01) {
      stopped = `run budget exhausted ($${spent.toFixed(2)} of $${run!.budget_usd})`;
      return;
    }
    const left = chunks.length - i;
    const chunkBudget = Math.max(0.05, Math.min(remaining, (remaining / left) * 1.5));
    const prompt = `/agentic-sales-engine:${o.skill} --icp ${o.icp} --unattended ${chunk.join(" ")}\n\n${UNATTENDED_NOTE(o.pluginRoot)}`;
    log(`[${i + 1}/${chunks.length}] ${o.skill} ${chunk.join(", ")} (≤ $${chunkBudget.toFixed(2)})`);
    const chunkSpan = startSpan("batch.chunk", { "ase.skill": o.skill, "ase.icp": o.icp, "ase.chunk": i, "ase.domains": chunk, "ase.budget_usd": chunkBudget, "ase.model": model }, runSpan);
    const attempt = async (): Promise<ChunkRunResult> => {
      let r: ChunkRunResult;
      try {
        r = await runner({ ws: o.ws, prompt, model, maxBudgetUsd: chunkBudget, pluginRoot: o.pluginRoot, span: chunkSpan });
      } catch (e) {
        r = { cost_usd: 0, ok: false, summary: `error: ${(e as Error).message}` };
        chunkSpan.recordException(e as Error);
      }
      // On a subscription the figure is API-equivalent usage, not money: logged, but outside the budget.
      appendLedger(o.ws, { run_id: run!.run_id, provider: "anthropic", op: `batch:${o.skill}`, usd: r.cost_usd, kind: "actual", note: chunk.join(" "), ...(modelSpendIsBilled(billing) ? {} : { billed: false }) });
      return r;
    };
    let r = await attempt();
    // Plan usage limit: wait for the reset when it's near (and retry this chunk), else stop the batch to resume later.
    while (r.limit?.limited && !stopped) {
      const wait = waitMs(r.limit, limitAttempts++);
      if (wait > maxWait) {
        usageLimit = r.limit;
        stopped = `usage limit: Claude plan usage limit reached${r.limit.resetsAt ? `, resets ${new Date(r.limit.resetsAt).toISOString()}` : ""}`;
        break;
      }
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      log(`usage limit reached — waiting ${Math.round(wait / 60_000)} min for the reset, then retrying ${chunk.join(", ")}`);
      await sleep(Math.max(0, pausedUntil - Date.now()));
      pausedUntil = 0;
      r = await attempt();
    }
    if (r.limit?.overage && !cfg.usage_limits.allow_extra_usage && !stopped) {
      usageLimit = r.limit;
      stopped = "usage limit: the session started using paid extra usage — stopped (set usage_limits.allow_extra_usage: true to allow it)";
    }
    const advanced: string[] = [];
    for (const d of chunk) {
      const p = paths.company(o.ws, d);
      if (!existsSync(p)) continue;
      const st = (await readDoc<Company>(p)).data.icp_status?.[o.icp]?.stage;
      if (st && st !== spec.fromStage) advanced.push(d);
    }
    results.push({ chunk: i, domains: chunk, ok: r.ok, cost_usd: r.cost_usd, advanced });
    setAttrs(chunkSpan, { "ase.cost_usd": r.cost_usd, "ase.ok": r.ok, "ase.advanced": advanced.length, "ase.denied": r.denied?.length ?? 0 });
    if (!r.ok) chunkSpan.setStatus({ code: 2, message: "chunk did not succeed" });
    chunkSpan.end();
    const deniedNote = r.denied?.length ? `- denied tool calls:\n${r.denied.map((d) => `  - \`${d}\``).join("\n")}\n` : "";
    appendFileSync(logFile, `## Chunk ${i + 1}: ${chunk.join(", ")}\n- ok: ${r.ok}, cost $${r.cost_usd.toFixed(3)}, advanced ${advanced.length}/${chunk.length}\n${deniedNote}\n${r.summary}\n\n`);
  });
  // Second opinion on fresh full scores (research and score batches), unless stopped or switched off.
  const reconciled: { domain: string; changed: number; disputed: number }[] = [];
  // With an injected session runner (tests, dry harnesses) it only runs when a judge is injected too.
  if ((o.skill === "research" || o.skill === "score") && cfg.judging.second_opinion && !stopped && !o.skipReconcile && (!o.runner || o.ask)) {
    const { reconcileAccount } = await import("./reconcile.ts");
    const ask = o.ask ?? askOnce(billing);
    const todo = results.flatMap((r) => r.domains);
    await pool(todo, o.concurrency ?? 3, async (d) => {
      try {
        const rr = await reconcileAccount(o.ws, o.icp, d, { ask, model: cfg.judging.model });
        if (rr.skipped) return;
        appendLedger(o.ws, { run_id: run!.run_id, provider: "anthropic", op: "reconcile", usd: rr.cost_usd, kind: "actual", note: `${d} ${rr.calls.map((c) => `[$${c.cost_usd.toFixed(3)} out ${c.out ?? "?"} think ${c.thinking ?? "?"}]`).join(" ")}`, ...(modelSpendIsBilled(billing) ? {} : { billed: false }) });
        reconciled.push({ domain: d, changed: rr.changed.length, disputed: rr.disputed.length });
        if (rr.changed.length || rr.disputed.length) log(`second opinion ${d}: ${rr.changed.map((c) => `${c.id} ${c.from}→${c.to}`).join(", ") || "no changes"}${rr.disputed.length ? `; disputed ${rr.disputed.join(", ")}` : ""} (${rr.before} → ${rr.after})`);
      } catch (e) {
        log(`second opinion ${d} failed: ${(e as Error).message}`);
      }
    });
    if (reconciled.length) appendFileSync(logFile, `## Second opinion\n${reconciled.map((r) => `- ${r.domain}: ${r.changed} changed, ${r.disputed} disputed`).join("\n")}\n\n`);
  }
  await reindexAll(o.ws);
  const advanced = results.flatMap((r) => r.advanced);
  const summary = {
    ...plan,
    dry_run: false,
    processed: results.reduce((n, r) => n + r.domains.length, 0),
    advanced: advanced.length,
    not_advanced: domains.filter((d) => results.some((r) => r.domains.includes(d)) && !advanced.includes(d)),
    spent_usd: spentForRun(o.ws, run.run_id),
    stopped: stopped as string | null,
    second_opinion: reconciled.length ? { accounts: reconciled.length, changed: reconciled.reduce((n, r) => n + r.changed, 0), disputed: reconciled.reduce((n, r) => n + r.disputed, 0) } : null,
    usage_limit: usageLimit ? { resets_at: (usageLimit as LimitState).resetsAt ? new Date((usageLimit as LimitState).resetsAt!).toISOString() : null, overage: (usageLimit as LimitState).overage } : null,
    log: logFile.slice(o.ws.length + 1) as string | null,
    results,
  };
  setAttrs(runSpan, { "ase.run_id": summary.run_id, "ase.accounts": summary.accounts, "ase.processed": summary.processed, "ase.advanced": summary.advanced, "ase.spent_usd": summary.spent_usd, "ase.stopped": summary.stopped });
  appendFileSync(logFile, `## Summary\nadvanced ${summary.advanced}/${summary.processed}, spent $${summary.spent_usd}${stopped ? `, stopped: ${stopped}` : ""}\n`);
  return summary;
}
