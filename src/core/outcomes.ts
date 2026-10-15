import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { parseYaml, readDoc } from "./frontmatter.ts";
import type { Company, ScoreFile, Signal } from "./schemas.ts";
import { wilson } from "./stats.ts";
import { paths } from "./workspace.ts";

/**
 * Outcome analytics: what actually happened with accounts, joined to how we scored them. Used by the status
 * dashboard (early read: does tier A convert better than B?), the win-loss skill (why we win and lose), and
 * recalibration (which factors predict success; see score.ts).
 */

export const OUTCOMES = ["meeting", "opportunity", "won", "lost", "no_response", "disqualified"] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** Engaged = the account took a meaningful step with us. */
export const POSITIVE: ReadonlySet<string> = new Set(["meeting", "opportunity", "won"]);
const RANK: Record<string, number> = { no_response: 0, disqualified: 1, lost: 2, meeting: 3, opportunity: 4, won: 5 };

export interface OutcomeRow {
  date: string;
  account: string;
  icp: string;
  member: string;
  outcome: Outcome;
  note: string;
}

export function readOutcomes(ws: string, icp?: string): OutcomeRow[] {
  const p = join(ws, "outcomes", "outcomes.csv");
  if (!existsSync(p)) return [];
  const rows = parseCsv(readFileSync(p, "utf8"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<string, string>[];
  return rows
    .filter((r) => OUTCOMES.includes(r.outcome as Outcome) && r.account && (!icp || r.icp === icp))
    .map((r) => ({ date: r.date ?? "", account: r.account!, icp: r.icp ?? "", member: r.member ?? "", outcome: r.outcome as Outcome, note: r.note ?? "" }));
}

/**
 * One result per account+ICP: the latest entry, except that a later `no_response` never hides an earlier meeting
 * or deal (an account that met us and then went quiet still engaged).
 */
export function latestOutcomes(rows: OutcomeRow[]): Map<string, OutcomeRow & { history: Outcome[] }> {
  const out = new Map<string, OutcomeRow & { history: Outcome[] }>();
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = `${r.account}|${r.icp}`;
    const prev = out.get(key);
    const history = [...(prev?.history ?? []), r.outcome];
    if (prev && r.outcome === "no_response" && RANK[prev.outcome]! > RANK.no_response!) out.set(key, { ...prev, history });
    else out.set(key, { ...r, history });
  }
  return out;
}

function scoreOf(ws: string, domain: string, icp: string): (ScoreFile & { path: string }) | null {
  const p = paths.score(ws, domain, icp);
  if (!existsSync(p)) return null;
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(p, "utf8"));
  return m ? { ...(parseYaml(m[1]!) as ScoreFile), path: p } : null;
}

async function signalTypes(ws: string, domain: string): Promise<string[]> {
  const dir = join(ws, "accounts", domain, "signals");
  if (!existsSync(dir)) return [];
  const types = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) types.add((await readDoc<Signal>(join(dir, f))).data.type);
  return [...types];
}

interface Bucket { n: number; engaged: number; won: number; rate: number | null; low: number; high: number }
const bucket = (n: number, engaged: number, won: number): Bucket => ({ n, engaged, won, ...wilson(engaged, n) });

export async function outcomeStats(ws: string, icp: string) {
  const latest = latestOutcomes(readOutcomes(ws, icp));
  const rows: { account: string; outcome: Outcome; tier: string | null; total: number | null; mode: string | null; signals: string[]; drafted: boolean }[] = [];
  for (const r of latest.values()) {
    const s = scoreOf(ws, r.account, icp);
    const ddir = join(ws, "accounts", r.account, "drafts");
    rows.push({
      account: r.account, outcome: r.outcome, tier: s?.tier ?? null, total: s?.total ?? null, mode: s?.mode ?? null,
      signals: await signalTypes(ws, r.account), drafted: existsSync(ddir) && readdirSync(ddir).some((f) => f.endsWith(".md")),
    });
  }
  const agg = (sel: typeof rows) => bucket(sel.length, sel.filter((x) => POSITIVE.has(x.outcome)).length, sel.filter((x) => x.outcome === "won").length);
  const byTier: Record<string, Bucket> = {};
  for (const t of ["A", "B", "C", "X", "unscored"]) {
    const sel = rows.filter((r) => (r.tier ?? "unscored") === t);
    if (sel.length) byTier[t] = agg(sel);
  }
  const byTrigger: Record<string, Bucket> = {};
  for (const t of [...new Set(rows.flatMap((r) => r.signals))].sort()) byTrigger[t] = agg(rows.filter((r) => r.signals.includes(t)));
  const noTrigger = rows.filter((r) => r.signals.length === 0);
  if (noTrigger.length) byTrigger["(none)"] = agg(noTrigger);
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length]));

  // Early read on whether the score ranks well: engaged accounts vs not, by median total.
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
  const scored = rows.filter((r) => r.total !== null);
  const engagedTotals = scored.filter((r) => POSITIVE.has(r.outcome)).map((r) => r.total!);
  const otherTotals = scored.filter((r) => !POSITIVE.has(r.outcome)).map((r) => r.total!);

  const full = rows.filter((r) => r.mode === "full");
  const fullPos = full.filter((r) => POSITIVE.has(r.outcome)).length;
  const ready = full.length >= 30 && fullPos >= 5 && full.length - fullPos >= 5;
  const tierA = byTier.A;
  const tierB = byTier.B;
  const signal =
    tierA && tierB && tierA.n >= 5 && tierB.n >= 5
      ? tierA.low > tierB.high
        ? "tier A clearly converts better than B"
        : tierA.high < tierB.low
          ? "tier B converts better than A — the model is mis-ranking; run win-loss"
          : "A vs B difference not yet distinguishable (overlapping intervals)"
      : "too few outcomes to compare tiers (need ≥ 5 per tier)";
  return {
    icp,
    accounts_with_outcome: rows.length,
    counts,
    overall: agg(rows),
    by_tier: byTier,
    by_trigger: byTrigger,
    median_score: { engaged: med(engagedTotals), not_engaged: med(otherTotals) },
    tier_signal: signal,
    recalibration: { ready, full_scored_with_outcome: full.length, positives: fullPos, needed: "≥30 full-scored outcomes incl. ≥5 positive and ≥5 negative" },
  };
}

/** Material for the win-loss skill: each outcome with its score summary, note, and where to read more. */
export async function winLossCases(ws: string, icp: string, since?: string) {
  const latest = latestOutcomes(readOutcomes(ws, icp));
  const out: { account: string; name: string | null; outcome: Outcome; date: string; note: string; history: Outcome[]; tier: string | null; total: number | null; factor_levels: Record<string, number | null>; signals: string[]; brief: string | null }[] = [];
  for (const r of latest.values()) {
    if (since && r.date < since) continue;
    const s = scoreOf(ws, r.account, icp);
    const cp = paths.company(ws, r.account);
    const name = existsSync(cp) ? (await readDoc<Company>(cp)).data.name : null;
    const brief = paths.brief(ws, r.account);
    out.push({
      account: r.account, name, outcome: r.outcome, date: r.date, note: r.note, history: r.history,
      tier: s?.tier ?? null, total: s?.total ?? null,
      factor_levels: Object.fromEntries((s?.factors ?? []).map((f) => [f.id, f.level])),
      signals: await signalTypes(ws, r.account),
      brief: existsSync(brief) ? `accounts/${r.account}/brief.md` : null,
    });
  }
  const order = (o: Outcome) => (POSITIVE.has(o) ? 0 : o === "lost" || o === "disqualified" ? 1 : 2);
  return out.sort((a, b) => order(a.outcome) - order(b.outcome) || b.date.localeCompare(a.date));
}
