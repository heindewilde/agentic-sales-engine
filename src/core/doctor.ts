import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, reindexAll } from "./db.ts";
import { readDoc } from "./frontmatter.ts";
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
    exa: has("EXA_API_KEY", "CLAUDE_PLUGIN_OPTION_EXA_API_KEY"),
    firecrawl: has("FIRECRAWL_API_KEY", "CLAUDE_PLUGIN_OPTION_FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL", "CLAUDE_PLUGIN_OPTION_FIRECRAWL_BASE_URL"),
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
  dayBudget: number;
  run: ReturnType<typeof currentRun>;
  gates: string[];
  problems: string[];
}

export async function health(ws: string): Promise<Health> {
  const problems: string[] = [];
  let dayBudget = 20;
  try {
    dayBudget = (await loadConfig(ws)).budgets.per_day_usd;
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
        if (data.status !== "approved") gates.push(`GATE 1 pending: ICP "${slug}" is ${data.status ?? "draft"} — review and approve it (/agentic-sales-engine:icp-build)`);
        else if (!hasScoring) gates.push(`ICP "${slug}" has no scoring model yet (/agentic-sales-engine:scoring-design)`);
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
  return { tier: tier(), icps, stages, staleFacts, spentToday: spentToday(ws), dayBudget, run: currentRun(ws), gates, problems };
}

export function formatBrief(h: Health): string {
  const lines = [`Sales engine workspace — provider tier ${h.tier.tier} (${h.tier.detail}).`];
  lines.push(`Spend today: $${h.spentToday.toFixed(2)} of $${h.dayBudget.toFixed(2)}.` + (h.run ? ` Active run: ${h.run.run_id} (budget $${h.run.budget_usd}).` : ""));
  if (h.icps.length === 0) lines.push("No ICP defined yet — start with /agentic-sales-engine:icp-build.");
  else lines.push(`ICPs: ${h.icps.map((i) => `${i.slug} [${i.status}${i.hasScoring ? ", scoring ✓" : ""}]`).join(", ")}.`);
  for (const [icp, s] of Object.entries(h.stages)) {
    lines.push(`Funnel ${icp}: ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  }
  if (h.staleFacts) lines.push(`${h.staleFacts} facts are past their TTL (/agentic-sales-engine:refresh).`);
  for (const g of h.gates) lines.push(g);
  for (const p of h.problems) lines.push(`Problem: ${p}`);
  return lines.join("\n");
}
