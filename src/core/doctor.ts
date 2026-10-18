import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, reindexAll } from "./db.ts";
import { readDoc } from "./frontmatter.ts";
import { claudeBilling, type ClaudeBilling } from "./billing.ts";
import { currentRun, spentToday } from "./ledger.ts";
import { loadConfig, paths } from "./workspace.ts";

export type Tier = "T0" | "T1" | "T2";

/** A usable env value: unset plugin options can arrive empty or as an unexpanded "${...}" placeholder. */
const has = (...names: string[]) => names.some((n) => {
  const v = process.env[n];
  return Boolean(v && !v.startsWith("${"));
});

export function providerKeys(): { exa: boolean; firecrawl: boolean } {
  return {
    exa: has("EXA_API_KEY", "ASE_EXA_API_KEY", "CLAUDE_PLUGIN_OPTION_EXA_API_KEY"),
    firecrawl: has("FIRECRAWL_API_KEY", "ASE_FIRECRAWL_API_KEY", "ASE_FIRECRAWL_BASE_URL", "CLAUDE_PLUGIN_OPTION_FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL", "CLAUDE_PLUGIN_OPTION_FIRECRAWL_BASE_URL"),
  };
}

export function tier(): { tier: Tier; detail: string } {
  const k = providerKeys();
  if (k.exa && k.firecrawl) return { tier: "T2", detail: "Exa + Firecrawl: full capability" };
  if (k.exa) return { tier: "T1", detail: "Exa only: discovery, people, news and research OK; site extraction falls back to Exa contents" };
  if (k.firecrawl) return { tier: "T1", detail: "Firecrawl only: site extraction OK; discovery limited to seed imports + web search" };
  return { tier: "T0", detail: "no provider keys: built-in web search/fetch + CSV imports only (slower, shallower)" };
}

export interface Health {
  tier: { tier: Tier; detail: string };
  icps: { slug: string; status: string; hasScoring: boolean }[];
  stages: Record<string, Record<string, number>>;
  staleFacts: number;
  spentToday: number;
  /** subscription: Claude usage is covered by the plan (budgets cap Exa/Firecrawl only); api: billed per token, budgets cover everything */
  claudeBilling: ClaudeBilling;
  dayBudget: number;
  run: ReturnType<typeof currentRun>;
  gates: string[];
  problems: string[];
  outcomes: Record<string, { accounts: number; resolved: number; engaged: number; needs_review: number }>;
}

export async function health(ws: string): Promise<Health> {
  const problems: string[] = [];
  let dayBudget = 20;
  let billing: ClaudeBilling = claudeBilling();
  try {
    const cfg = await loadConfig(ws);
    dayBudget = cfg.budgets.per_day_usd;
    billing = claudeBilling(cfg.claude_billing);
  } catch (e) {
    problems.push(`ase.config.yaml is invalid: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!existsSync(paths.db(ws))) await reindexAll(ws);

  const icps: Health["icps"] = [];
  const gates: string[] = [];
  const icpDir = join(ws, "icps");
  if (existsSync(icpDir)) {
    for (const slug of readdirSync(icpDir)) {
      const p = paths.icp(ws, slug);
      if (!existsSync(p)) continue;
      try {
        const { data } = await readDoc<{ status?: string }>(p);
        const hasScoring = existsSync(paths.scoring(ws, slug));
        icps.push({ slug, status: data.status ?? "draft", hasScoring });
        if (data.status !== "approved") gates.push(`GATE 1 pending: ICP "${slug}" is ${data.status ?? "draft"} — review and approve it (/agentic-sales-engine:icp)`);
        else if (!hasScoring) gates.push(`ICP "${slug}" has no scoring model yet (/agentic-sales-engine:icp --scoring)`);
      } catch {
        problems.push(`icps/${slug}/icp.md has unreadable frontmatter`);
      }
    }
  }

  const db = openDb(ws);
  const stages: Health["stages"] = {};
  let staleFacts = 0;
  try {
    for (const r of db.query("SELECT icp, stage, COUNT(*) n FROM account_icp GROUP BY icp, stage").all() as { icp: string; stage: string; n: number }[]) {
      (stages[r.icp] ??= {})[r.stage] = r.n;
    }
    staleFacts = (db.query("SELECT COUNT(*) n FROM facts WHERE expires_at IS NOT NULL AND expires_at < date('now')").get() as { n: number }).n;
  } finally {
    db.close();
  }
  for (const [icp, s] of Object.entries(stages)) {
    if ((s.light_scored ?? 0) > 0) gates.push(`GATE 2 pending: ${s.light_scored} light-scored accounts for "${icp}" await shortlist approval (/agentic-sales-engine:shortlist)`);
  }
  const { accountStates, openItems, readEvents } = await import("./outcomes.ts");
  const outcomes: Health["outcomes"] = {};
  for (const i of icps) {
    const states = accountStates(readEvents(ws, i.slug));
    if (!states.size) continue;
    const all = [...states.values()];
    const items = openItems(states);
    outcomes[i.slug] = {
      accounts: all.length,
      resolved: all.filter((x) => !x.pending).length,
      engaged: all.filter((x) => x.engaged).length,
      needs_review: items.filter((x) => x.urgency >= 3).length,
    };
  }
  const { listRuns } = await import("./autopilot.ts");
  for (const r of listRuns(ws).filter((x) => x.status === "running" || x.status === "waiting" || x.status === "failed")) {
    if (r.status === "waiting" && r.gate) gates.unshift(`Autopilot ${r.run_id} (${r.icp}) is waiting: ${r.gate.message}`);
    else if (r.status === "failed") problems.push(`Autopilot ${r.run_id} (${r.icp}) failed at ${r.steps.find((s) => s.status === "failed")?.id ?? "?"} — fix and run: bun <plugin>/src/cli/autopilot.ts resume ${r.run_id}`);
    else gates.unshift(`Autopilot ${r.run_id} (${r.icp}) is running (step ${r.steps.find((s) => s.status === "running")?.id ?? "?"}).`);
  }
  return { tier: tier(), icps, stages, staleFacts, spentToday: spentToday(ws), claudeBilling: billing, dayBudget, run: currentRun(ws), gates, problems, outcomes };
}

export function formatBrief(h: Health): string {
  const lines = [`Sales engine workspace — provider tier ${h.tier.tier} (${h.tier.detail}).`];
  lines.push(h.claudeBilling === "api" ? "Claude: API key — billed per token; budgets cover Claude and data providers." : "Claude: your subscription — no per-token cost (plan usage limits apply); budgets only cap Exa/Firecrawl, don't ask for one.");
  lines.push(`${h.claudeBilling === "api" ? "Spend" : "Provider spend"} today: $${h.spentToday.toFixed(2)} of $${h.dayBudget.toFixed(2)}.` + (h.run ? ` Active run: ${h.run.run_id} (budget $${h.run.budget_usd}).` : ""));
  if (h.icps.length === 0) lines.push("No ICP defined yet — start with /agentic-sales-engine:icp.");
  else lines.push(`ICPs: ${h.icps.map((i) => `${i.slug} [${i.status}${i.hasScoring ? ", scoring ✓" : ""}]`).join(", ")}.`);
  for (const [icp, s] of Object.entries(h.stages)) {
    lines.push(`Funnel ${icp}: ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  }
  for (const [icp, o] of Object.entries(h.outcomes)) {
    lines.push(
      `Outcomes ${icp}: ${o.accounts} ${o.accounts === 1 ? "account" : "accounts"} in outreach, ${o.resolved} resolved, ${o.engaged} engaged.` +
        (o.needs_review ? ` ${o.needs_review} ${o.needs_review === 1 ? "needs" : "need"} a status update — run /agentic-sales-engine:outcomes.` : "") +
        (o.resolved >= 30 ? " Enough for recalibration; consider /agentic-sales-engine:outcomes analyze." : ""),
    );
  }
  if (h.staleFacts) lines.push(`${h.staleFacts} facts are past their TTL (/agentic-sales-engine:refresh).`);
  for (const g of h.gates) lines.push(g);
  for (const p of h.problems) lines.push(`Problem: ${p}`);
  return lines.join("\n");
}
