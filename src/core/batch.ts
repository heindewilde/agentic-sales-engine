import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reindexAll } from "./db.ts";
import { readDoc } from "./frontmatter.ts";
import { appendLedger, currentRun, newRunId, spentForRun, type CurrentRun } from "./ledger.ts";
import type { Company } from "./schemas.ts";
import { loadConfig, paths } from "./workspace.ts";

/**
 * Batch driver: runs a stage skill over many accounts in chunks, each chunk in its own headless Claude
 * session (Agent SDK) with the plugin loaded — so hooks, the provider gateway and budgets all apply —
 * and with bounded concurrency. Resumable: accounts are selected by stage, and a processed account moves on.
 */

export const BATCH_SKILLS = {
  "enrich-light": { fromStage: "discovered", toStage: "light_scored", defaultModel: "light" as const, defaultChunk: 10 },
  research: { fromStage: "shortlisted", toStage: "researched", defaultModel: "research" as const, defaultChunk: 1 },
  score: { fromStage: "researched", toStage: "scored", defaultModel: "research" as const, defaultChunk: 5 },
} as const;
export type BatchSkill = keyof typeof BATCH_SKILLS;

export interface ChunkRunner {
  (args: { ws: string; prompt: string; model: string; maxBudgetUsd: number; pluginRoot: string }): Promise<{ cost_usd: number; ok: boolean; summary: string; denied?: string[] }>;
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
  ].join("\n");

const MODEL_ALIASES: Record<string, string> = { haiku: "haiku", sonnet: "sonnet", opus: "opus" };

/** Default runner: one Agent SDK session per chunk. */
export const sdkRunner: ChunkRunner = async ({ ws, prompt, model, maxBudgetUsd, pluginRoot }) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  // .mcp.json overrides EXA_API_KEY with the plugin's userConfig value (empty in SDK runs) — pass ASE_* copies.
  for (const k of ["EXA_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL"]) if (env[k]) env[`ASE_${k}`] = env[k]!;
  let cost = 0;
  let ok = false;
  let summary = "";
  const denied: string[] = [];
  const pending = new Map<string, string>();
  for await (const m of query({
    prompt,
    options: {
      cwd: ws,
      model: MODEL_ALIASES[model] ?? model,
      plugins: [{ type: "local", path: pluginRoot }],
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: [
        "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebSearch", "WebFetch",
        `Bash(bun ${pluginRoot}/src/cli/ase.ts *)`,
        "mcp__plugin_agentic-sales-engine_ase",
      ],
      maxBudgetUsd,
      maxTurns: 200,
      env,
    },
  })) {
    // Record refused tool calls so batch logs show permission problems instead of silent non-progress.
    if (m.type === "assistant") {
      for (const c of (m as { message: { content: { type: string; id?: string; name?: string; input?: unknown }[] } }).message.content) {
        if (c.type === "tool_use" && c.id) pending.set(c.id, `${c.name} ${JSON.stringify(c.input).slice(0, 300)}`);
      }
    }
    if (m.type === "user") {
      const content = (m as { message: { content?: unknown } }).message.content;
      for (const c of Array.isArray(content) ? (content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) : []) {
        if (c.type === "tool_result" && c.is_error && /permission|denied|not allowed/i.test(JSON.stringify(c.content))) {
          denied.push(pending.get(c.tool_use_id ?? "") ?? "unknown tool");
        }
      }
    }
    if (m.type === "result") {
      const r = m as { subtype: string; total_cost_usd?: number; result?: string };
      cost = r.total_cost_usd ?? 0;
      ok = r.subtype === "success";
      summary = (r.result ?? r.subtype).slice(0, 2000);
    }
  }
  return { cost_usd: cost, ok, summary, denied };
};

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
  const spec = BATCH_SKILLS[o.skill];
  const cfg = await loadConfig(o.ws);
  const log = o.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  let domains = o.domains ?? (await accountsAtStage(o.ws, o.icp, spec.fromStage));
  if (o.limit) domains = domains.slice(0, o.limit);
  const chunkSize = o.chunk ?? spec.defaultChunk;
  const chunks: string[][] = [];
  for (let i = 0; i < domains.length; i += chunkSize) chunks.push(domains.slice(i, i + chunkSize));
  const model = o.model ?? cfg.models[spec.defaultModel];

  // Reuse the active run (e.g. the budget approved at GATE 2) or start one.
  let run: CurrentRun | null = currentRun(o.ws);
  if (!run || run.icp !== o.icp) {
    run = { run_id: newRunId(o.skill), stage: o.skill, icp: o.icp, budget_usd: o.budgetUsd ?? cfg.budgets.per_run_usd, started: new Date().toISOString() };
    if (!o.dryRun) {
      mkdirSync(dirname(paths.currentRun(o.ws)), { recursive: true });
      writeFileSync(paths.currentRun(o.ws), JSON.stringify(run, null, 2));
    }
  }
  const plan = { run_id: run.run_id, skill: o.skill, icp: o.icp, model, accounts: domains.length, chunks: chunks.length, chunk_size: chunkSize, budget_usd: run.budget_usd };
  type ChunkResult = { chunk: number; domains: string[]; ok: boolean; cost_usd: number; advanced: string[] };
  const empty = { processed: 0, advanced: 0, not_advanced: [] as string[], spent_usd: 0, stopped: null as string | null, log: null as string | null, results: [] as ChunkResult[] };
  if (o.dryRun || chunks.length === 0) return { ...plan, dry_run: Boolean(o.dryRun), ...empty };

  const logFile = join(o.ws, "lists", o.icp, run.run_id, `batch-${o.skill}.md`);
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `# Batch ${o.skill} — ${o.icp} — ${new Date().toISOString()}\n\nmodel ${model}, ${domains.length} accounts in ${chunks.length} chunks, budget $${run.budget_usd}\n\n`);

  const results: ChunkResult[] = [];
  let stopped: string | null = null;
  await pool(chunks, o.concurrency ?? 3, async (chunk, i) => {
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
    let r: Awaited<ReturnType<ChunkRunner>>;
    try {
      r = await (o.runner ?? sdkRunner)({ ws: o.ws, prompt, model, maxBudgetUsd: chunkBudget, pluginRoot: o.pluginRoot });
    } catch (e) {
      r = { cost_usd: 0, ok: false, summary: `error: ${(e as Error).message}` };
    }
    appendLedger(o.ws, { run_id: run!.run_id, provider: "anthropic", op: `batch:${o.skill}`, usd: r.cost_usd, kind: "actual", note: chunk.join(" ") });
    const advanced: string[] = [];
    for (const d of chunk) {
      const p = paths.company(o.ws, d);
      if (!existsSync(p)) continue;
      const st = (await readDoc<Company>(p)).data.icp_status?.[o.icp]?.stage;
      if (st && st !== spec.fromStage) advanced.push(d);
    }
    results.push({ chunk: i, domains: chunk, ok: r.ok, cost_usd: r.cost_usd, advanced });
    const deniedNote = r.denied?.length ? `- denied tool calls:\n${r.denied.map((d) => `  - \`${d}\``).join("\n")}\n` : "";
    appendFileSync(logFile, `## Chunk ${i + 1}: ${chunk.join(", ")}\n- ok: ${r.ok}, cost $${r.cost_usd.toFixed(3)}, advanced ${advanced.length}/${chunk.length}\n${deniedNote}\n${r.summary}\n\n`);
  });
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
    log: logFile.slice(o.ws.length + 1) as string | null,
    results,
  };
  appendFileSync(logFile, `## Summary\nadvanced ${summary.advanced}/${summary.processed}, spent $${summary.spent_usd}${stopped ? `, stopped: ${stopped}` : ""}\n`);
  return summary;
}
