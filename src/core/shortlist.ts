import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canTransition } from "./contracts.ts";
import { readDoc, stringifyDoc } from "./frontmatter.ts";
import { newRunId } from "./ledger.ts";
import type { Company } from "./schemas.ts";
import { rank, type RankRow } from "./scorefile.ts";
import { loadConfig, paths, today } from "./workspace.ts";

export interface ShortlistProposal {
  icp: string;
  run_id: string;
  path: string;
  pool: number;
  picked: (RankRow & { why: string })[];
  cost: { per_account_p50: number; per_account_p90: number; total_p50: number; total_p90: number };
}

/**
 * Propose which light-scored accounts deserve deep research: the top `pct`% by score, plus accounts whose
 * upside is high but coverage low ("research to resolve") — capped at `max`. Knocked-out accounts never qualify.
 * Writes lists/<icp>/<run>/shortlist.md with a checkbox per account for the human gate.
 */
export async function proposeShortlist(ws: string, icp: string, opts: { pct?: number; max?: number } = {}): Promise<ShortlistProposal> {
  const cfg = await loadConfig(ws).catch(() => null);
  const pct = opts.pct ?? cfg?.funnel.shortlist_pct ?? 15;
  const max = opts.max ?? cfg?.funnel.max_deep_research ?? 50;
  const pool = (await rank(ws, icp, { stage: "light_scored" })).filter((r) => r.tier !== "X");
  const nTop = Math.max(1, Math.ceil((pool.length * pct) / 100));
  const top = pool.slice(0, nTop).map((r) => ({ ...r, why: `top ${pct}% (score ${r.total})` }));
  const topSet = new Set(top.map((t) => t.domain));
  const resolve = pool
    .filter((r) => !topSet.has(r.domain) && r.research_to_resolve && r.upside >= (pool[nTop - 1]?.total ?? 0))
    .sort((a, b) => b.upside - a.upside)
    .slice(0, Math.ceil(nTop / 3))
    .map((r) => ({ ...r, why: `research to resolve (upside ${r.upside}, coverage ${Math.round(r.coverage * 100)}%)` }));
  const picked = [...top, ...resolve].slice(0, max);

  const perP50 = cfg?.budgets.deep_research_per_account_usd ?? 0.6;
  const perP90 = Math.round(perP50 * 2 * 100) / 100;
  const cost = {
    per_account_p50: perP50,
    per_account_p90: perP90,
    total_p50: Math.round(perP50 * picked.length * 100) / 100,
    total_p90: Math.round(perP90 * picked.length * 100) / 100,
  };
  const runId = newRunId("shortlist");
  const rel = `lists/${icp}/${runId}/shortlist.md`;
  const abs = join(ws, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const rows = picked.map((r) => `| [x] | ${r.domain} | ${r.name.replace(/\|/g, "/")} | ${r.total} | ${r.upside} | ${Math.round(r.coverage * 100)}% | ${r.tier} | ${r.needs_check.join(", ") || "—"} | ${r.why} |`);
  const body = [
    `# Shortlist proposal — ${icp} (${today()})`,
    "",
    `Pool: ${pool.length} light-scored accounts. Proposed for deep research: **${picked.length}**.`,
    `Estimated cost: **$${cost.total_p50} typical, up to $${cost.total_p90}** ($${perP50}–$${perP90} per account, provider + model usage).`,
    "",
    "Untick `[x]` → `[ ]` to drop an account; add a row with `[x]` to include another. Then approve (GATE 2).",
    "",
    "| Research | Domain | Name | Score | Upside | Coverage | Tier | Needs check | Why |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(abs, stringifyDoc({ icp, run_id: runId, status: "proposed", proposed_at: today(), cost }, body));
  return { icp, run_id: runId, path: rel, pool: pool.length, picked, cost };
}

/** Domains ticked `[x]` in a shortlist file. */
export function tickedDomains(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\|\s*\[[xX]\]\s*\|\s*([a-z0-9.-]+\.[a-z]{2,})\s*\|/gm)) out.push(m[1]!);
  return [...new Set(out)];
}

/** GATE 2: record the human approval on each ticked account and move it to `shortlisted`. */
export async function approveShortlist(ws: string, icp: string, shortlistRel: string, by: string) {
  const abs = join(ws, shortlistRel);
  if (!existsSync(abs)) throw new Error(`${shortlistRel} not found`);
  const cfg = await loadConfig(ws).catch(() => null);
  if (cfg && cfg.members.length && !cfg.members.some((m) => m.id === by)) {
    throw new Error(`"${by}" is not a member in ase.config.yaml — approvals must name a team member`);
  }
  const { data, body } = await readDoc<Record<string, unknown>>(abs);
  const domains = tickedDomains(body);
  const approved: string[] = [];
  const skipped: { domain: string; reason: string }[] = [];
  for (const d of domains) {
    const cp = paths.company(ws, d);
    if (!existsSync(cp)) {
      skipped.push({ domain: d, reason: "no account file" });
      continue;
    }
    const doc = await readDoc<Company>(cp);
    const st = doc.data.icp_status?.[icp];
    if (!st) {
      skipped.push({ domain: d, reason: `not in ICP ${icp}` });
      continue;
    }
    if (!canTransition(st.stage, "shortlisted") || st.stage === "excluded") {
      skipped.push({ domain: d, reason: `stage is ${st.stage}` });
      continue;
    }
    if (st.stage === "discovered") {
      skipped.push({ domain: d, reason: "not light-scored yet" });
      continue;
    }
    if (st.stage === "light_scored") st.stage = "shortlisted";
    st.approved_by = by;
    st.run_id = String(data.run_id ?? st.run_id ?? "");
    st.updated = today();
    writeFileSync(cp, stringifyDoc(doc.data, doc.body));
    approved.push(d);
  }
  const cost = (data.cost as { per_account_p90?: number } | undefined)?.per_account_p90 ?? cfg?.budgets.deep_research_per_account_usd ?? 0.6;
  data.status = "approved";
  data.approved_by = by;
  data.approved_at = today();
  data.approved_domains = approved.length;
  writeFileSync(abs, stringifyDoc(data, body));
  return { approved, skipped, run_id: data.run_id, suggested_budget_usd: Math.round(cost * approved.length * 100) / 100 };
}

export function readShortlist(ws: string, rel: string): string {
  return readFileSync(join(ws, rel), "utf8");
}
