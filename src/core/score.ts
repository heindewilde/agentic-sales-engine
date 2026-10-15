import type { Factor, FactorScore, Level, Scoring } from "./schemas.ts";
import { auc, kendallTau, logisticRegression, median, percentileRank, precisionAtK } from "./stats.ts";

/**
 * Deterministic scoring. The LLM judge supplies per-factor levels (0–3 or null) with evidence and
 * confidence; everything numeric happens here so scores are reproducible and explainable.
 */

export type Mode = "light" | "full";

export interface ScoreResult {
  total: number;
  upside: number;
  coverage: number;
  tier: "A" | "B" | "C" | "X";
  knocked_out: string[];
  needs_check: string[];
  groups: Record<"fit" | "intent" | "access", number | null>;
}

export function factorsFor(scoring: Scoring, mode: Mode): Factor[] {
  return mode === "light" ? scoring.factors.filter((f) => f.light) : scoring.factors;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Compute total/upside/coverage/tier from judged factor levels. Factors missing from `judged` count as unknown. */
export function computeScore(scoring: Scoring, judged: Pick<FactorScore, "id" | "level" | "confidence">[], mode: Mode): ScoreResult {
  const byId = new Map(judged.map((j) => [j.id, j]));
  const factors = factorsFor(scoring, mode);
  const knocked: string[] = [];
  const needsCheck: string[] = [];

  const groupScore = (assumeUnknown: number | "prior") => {
    const res: Record<"fit" | "intent" | "access", number | null> = { fit: null, intent: null, access: null };
    for (const g of ["fit", "intent", "access"] as const) {
      const fs = factors.filter((f) => f.group === g);
      if (!fs.length) continue;
      let num = 0;
      let den = 0;
      for (const f of fs) {
        const j = byId.get(f.id);
        const known = j && j.level !== null && j.level !== undefined;
        const level = known ? (j.level as number) : assumeUnknown === "prior" ? (f.unknown_prior ?? scoring.unknown_prior) : assumeUnknown;
        const conf = known ? j.confidence : 1;
        const w = f.weight * (0.5 + 0.5 * conf);
        num += w * (level / 3);
        den += w;
      }
      res[g] = den ? (num / den) * 100 : null;
    }
    return res;
  };

  const combine = (gs: Record<"fit" | "intent" | "access", number | null>) => {
    // Renormalize group weights over groups that have factors in this mode (light mode may lack some groups).
    let num = 0;
    let den = 0;
    for (const g of ["fit", "intent", "access"] as const) {
      if (gs[g] === null) continue;
      num += scoring.groups[g] * gs[g]!;
      den += scoring.groups[g];
    }
    return den ? num / den : 0;
  };

  const groups = groupScore("prior");
  const total = combine(groups);
  const upside = combine(groupScore(3));

  let knownWeight = 0;
  let allWeight = 0;
  for (const f of factors) {
    allWeight += f.weight;
    const j = byId.get(f.id);
    const known = j && j.level !== null && j.level !== undefined;
    if (known) knownWeight += f.weight;
    if (f.knockout) {
      if (known && (j.level as number) <= f.knockout.level_lte) knocked.push(f.id);
      else if (!known) needsCheck.push(f.id);
    }
  }

  const tier = knocked.length ? "X" : total >= scoring.tiers.A ? "A" : total >= scoring.tiers.B ? "B" : "C";
  return {
    total: round1(total),
    upside: round1(Math.max(upside, total)),
    coverage: allWeight ? Math.round((knownWeight / allWeight) * 100) / 100 : 0,
    tier,
    knocked_out: knocked,
    needs_check: needsCheck,
    groups: { fit: groups.fit === null ? null : round1(groups.fit), intent: groups.intent === null ? null : round1(groups.intent), access: groups.access === null ? null : round1(groups.access) },
  };
}

/** Strip levels the judge could not back with evidence (the hook would reject them anyway). */
export function sanitizeJudgements(judged: FactorScore[]): FactorScore[] {
  return judged.map((j) => (j.level !== null && (!j.evidence || j.evidence.length === 0) ? { ...j, level: null, confidence: 0 } : j));
}

// ---------- calibration ----------

export interface LabeledAccount {
  domain: string;
  label: "good" | "bad" | null;
  judged: Pick<FactorScore, "id" | "level" | "confidence">[];
}

export interface Backtest {
  n_good: number;
  n_bad: number;
  n_unlabeled: number;
  auc: number | null;
  /** median share (0–100) of non-good accounts that a known-good customer outranks */
  good_median_percentile: number | null;
  precision_at_k: number | null;
  k: number;
  verdict: "pass" | "weak" | "fail" | "insufficient_data";
  misranked: { domain: string; label: "good" | "bad"; total: number; percentile: number }[];
}

/** How well does the model rank known-good customers above known-bad ones (and above the unlabeled population)? */
export function backtest(scoring: Scoring, accounts: LabeledAccount[], mode: Mode = "full"): Backtest {
  const scored = accounts.map((a) => ({ ...a, total: computeScore(scoring, a.judged, mode).total }));
  const labeled = scored.filter((a) => a.label);
  const goods = scored.filter((a) => a.label === "good");
  const bads = scored.filter((a) => a.label === "bad");
  // Each good customer's percentile among all *other* (non-good) accounts: "outranks X% of the field".
  const others = scored.filter((a) => a.label !== "good").map((a) => a.total);
  const a = auc(labeled.map((x) => x.total), labeled.map((x) => x.label === "good"));
  const goodPct = goods.map((g) => percentileRank(g.total, others));
  const k = goods.length;
  const p = precisionAtK(labeled.map((x) => x.total), labeled.map((x) => x.label === "good"), k);
  const med = median(goodPct);
  const goodMedianTotal = median(goods.map((g) => g.total));
  const misranked = [
    ...goods.filter((g) => percentileRank(g.total, others) < 50).map((g) => ({ g, pct: percentileRank(g.total, others) })),
    ...bads.filter((b) => goodMedianTotal !== null && b.total >= goodMedianTotal).map((b) => ({ g: b, pct: percentileRank(b.total, scored.map((x) => x.total)) })),
  ].map(({ g: x, pct }) => ({ domain: x.domain, label: x.label!, total: x.total, percentile: Math.round(pct) }));

  let verdict: Backtest["verdict"] = "insufficient_data";
  if (goods.length >= 3 && bads.length >= 2 && a !== null && med !== null) {
    verdict = a >= 0.8 && med >= 75 ? "pass" : a >= 0.65 ? "weak" : "fail";
  }
  return {
    n_good: goods.length,
    n_bad: bads.length,
    n_unlabeled: scored.length - labeled.length,
    auc: a === null ? null : Math.round(a * 1000) / 1000,
    good_median_percentile: med === null ? null : Math.round(med),
    precision_at_k: p === null ? null : Math.round(p * 100) / 100,
    k,
    verdict,
    misranked,
  };
}

export interface Sensitivity {
  factor: string;
  tau_weight_up: number;
  tau_weight_down: number;
  tau_drop: number;
  flag: "dead" | "dominant" | null;
}

/**
 * Ranking stability per factor: rescale its weight ±20% and drop it entirely, measuring Kendall τ against
 * the baseline ranking. Dropping a factor that changes nothing (τ ≥ 0.98) = dead weight; dropping one that
 * reorders a lot (τ < 0.6) = dominant.
 */
export function sensitivity(scoring: Scoring, accounts: LabeledAccount[], mode: Mode = "full"): Sensitivity[] {
  const base = accounts.map((a) => computeScore(scoring, a.judged, mode).total);
  const withWeight = (id: string, mult: number): Scoring => ({
    ...scoring,
    factors: scoring.factors.map((f) => (f.id === id ? { ...f, weight: f.weight * mult } : f)),
  });
  const dropped = (id: string): Scoring => {
    const fs = scoring.factors.filter((f) => f.id !== id);
    return { ...scoring, factors: fs };
  };
  const tauFor = (s: Scoring) => {
    if (!factorsFor(s, mode).length) return 0;
    return kendallTau(base, accounts.map((a) => computeScore(s, a.judged, mode).total));
  };
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return factorsFor(scoring, mode).map((f) => {
    const drop = tauFor(dropped(f.id));
    return {
      factor: f.id,
      tau_weight_up: r3(tauFor(withWeight(f.id, 1.2))),
      tau_weight_down: r3(tauFor(withWeight(f.id, 0.8))),
      tau_drop: r3(drop),
      flag: drop >= 0.98 ? "dead" : drop < 0.6 ? "dominant" : null,
    };
  });
}

/**
 * Propose factor weights from logged outcomes (positive = meeting/opportunity/won). Coefficients are mapped
 * back to the 1–5 weight scale. A proposal only — a human applies it via scoring-design.
 */
export function recalibrate(scoring: Scoring, rows: { judged: Pick<FactorScore, "id" | "level">[]; positive: boolean }[]) {
  const factors = scoring.factors;
  const X = rows.map((r) => {
    const m = new Map(r.judged.map((j) => [j.id, j.level]));
    return factors.map((f) => (m.get(f.id) ?? f.unknown_prior ?? scoring.unknown_prior) as number);
  });
  const y = rows.map((r) => (r.positive ? 1 : 0));
  const { coef } = logisticRegression(X, y, { l2: 0.05, iterations: 4000 });
  const maxPos = Math.max(...coef.map((c) => Math.max(c, 0)), 1e-9);
  const factorsOut = factors.map((f, i) => {
    const c = coef[i]!;
    const proposed = c <= 0 ? 0.5 : Math.max(0.5, Math.round((c / maxPos) * 5 * 2) / 2);
    return { factor: f.id, group: f.group, current_weight: f.weight, coefficient: Math.round(c * 1000) / 1000, proposed_weight: proposed };
  });
  // Group weights cap how much any factor can matter, so propose them too: share of positive predictive
  // weight per group, floored at 0.1 so no dimension disappears, rounded to 0.05 and summing to 1.
  const groups = ["fit", "intent", "access"] as const;
  const mass = Object.fromEntries(groups.map((g) => [g, factors.reduce((a, f, i) => a + (f.group === g ? Math.max(coef[i]!, 0) : 0), 0)])) as Record<(typeof groups)[number], number>;
  const total = groups.reduce((a, g) => a + mass[g], 0);
  let proposedGroups = Object.fromEntries(groups.map((g) => [g, total > 0 ? Math.max(0.1, mass[g] / total) : scoring.groups[g]])) as Record<(typeof groups)[number], number>;
  const norm = groups.reduce((a, g) => a + proposedGroups[g], 0);
  proposedGroups = Object.fromEntries(groups.map((g) => [g, Math.round((proposedGroups[g] / norm) * 20) / 20])) as typeof proposedGroups;
  const drift = 1 - groups.reduce((a, g) => a + proposedGroups[g], 0);
  const biggest = groups.reduce((a, g) => (proposedGroups[g] > proposedGroups[a] ? g : a), "fit" as (typeof groups)[number]);
  proposedGroups[biggest] = Math.round((proposedGroups[biggest] + drift) * 100) / 100;
  return { factors: factorsOut, groups: { current: scoring.groups, proposed: proposedGroups } };
}

export type { Level };
