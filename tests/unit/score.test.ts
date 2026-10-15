import { describe, expect, test } from "bun:test";
import { backtest, computeScore, recalibrate, sanitizeJudgements, sensitivity, type LabeledAccount } from "../../src/core/score.ts";
import { Scoring } from "../../src/core/schemas.ts";
import { auc, kendallTau, logisticRegression, median, percentileRank, precisionAtK } from "../../src/core/stats.ts";

describe("stats", () => {
  test("auc", () => {
    expect(auc([0.9, 0.8, 0.3, 0.1], [true, true, false, false])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [true, true, false, false])).toBe(0);
    expect(auc([0.5, 0.5], [true, false])).toBe(0.5);
    // sklearn.roc_auc_score([1,0,1,0,1],[0.9,0.8,0.7,0.6,0.2]) == 0.5
    expect(auc([0.9, 0.8, 0.7, 0.6, 0.2], [true, false, true, false, true])).toBeCloseTo(0.5);
    // sklearn.roc_auc_score([0,0,1,1],[0.1,0.4,0.35,0.8]) == 0.75
    expect(auc([0.1, 0.4, 0.35, 0.8], [false, false, true, true])).toBeCloseTo(0.75);
    expect(auc([1, 2], [true, true])).toBeNull();
  });
  test("kendall tau-b", () => {
    expect(kendallTau([1, 2, 3, 4], [1, 2, 3, 4])).toBe(1);
    expect(kendallTau([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    // scipy.stats.kendalltau([12,2,1,12,2],[1,4,7,1,0]) -> -0.4714045
    expect(kendallTau([12, 2, 1, 12, 2], [1, 4, 7, 1, 0])).toBeCloseTo(-0.4714045, 6);
  });
  test("percentile, median, precision@k", () => {
    expect(percentileRank(3, [1, 2, 3, 4])).toBe(62.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(precisionAtK([9, 8, 7, 1], [true, false, true, true], 2)).toBe(0.5);
  });
  test("logistic regression separates a clear signal", () => {
    const X = [[0], [0], [1], [2], [3], [3], [1], [2]];
    const y = [0, 0, 0, 1, 1, 1, 0, 1];
    const { coef } = logisticRegression(X, y, { l2: 0, iterations: 20000, lr: 0.5 });
    expect(coef[0]!).toBeGreaterThan(1.5);
  });
});

const model = Scoring.parse({
  icp: "mm",
  version: 1,
  groups: { fit: 0.5, intent: 0.3, access: 0.2 },
  tiers: { A: 70, B: 50 },
  unknown_prior: 1,
  factors: [
    { id: "size", name: "Size", group: "fit", weight: 3, light: true, knockout: { level_lte: 0 }, question: "?", levels: { 0: "a", 1: "b", 2: "c", 3: "d" } },
    { id: "industry", name: "Industry", group: "fit", weight: 3, light: true, question: "?", levels: { 0: "a", 1: "b", 2: "c", 3: "d" } },
    { id: "trigger", name: "Trigger", group: "intent", weight: 2, question: "?", levels: { 0: "a", 1: "b", 2: "c", 3: "d" } },
    { id: "warm", name: "Warm", group: "access", weight: 1, question: "?", levels: { 0: "a", 1: "b", 2: "c", 3: "d" } },
  ],
});

const j = (levels: Record<string, number | null>, conf = 1) => Object.entries(levels).map(([id, level]) => ({ id, level: level as 0 | 1 | 2 | 3 | null, confidence: level === null ? 0 : conf }));

describe("computeScore", () => {
  test("all max = 100, all zero but knockout = X", () => {
    expect(computeScore(model, j({ size: 3, industry: 3, trigger: 3, warm: 3 }), "full")).toMatchObject({ total: 100, upside: 100, coverage: 1, tier: "A" });
    const zero = computeScore(model, j({ size: 0, industry: 0, trigger: 0, warm: 0 }), "full");
    expect(zero).toMatchObject({ total: 0, tier: "X", knocked_out: ["size"] });
  });

  test("worked example matches the documented formula", () => {
    // fit: size 3 (conf 1 → w 3), industry 2 (conf 0.5 → w 2.25): (3*1 + 2.25*2/3)/5.25 = 4.5/5.25 = 85.714
    // intent: trigger unknown → prior 1, w 2: 33.333 ; access: warm 3 → 100
    // total = .5*85.714 + .3*33.333 + .2*100 = 42.857 + 10 + 20 = 72.857
    const r = computeScore(model, [
      { id: "size", level: 3, confidence: 1 },
      { id: "industry", level: 2, confidence: 0.5 },
      { id: "trigger", level: null, confidence: 0 },
      { id: "warm", level: 3, confidence: 1 },
    ], "full");
    expect(r.total).toBe(72.9);
    expect(r.groups).toEqual({ fit: 85.7, intent: 33.3, access: 100 });
    // upside: trigger = 3 → intent 100 → 42.857+30+20 = 92.857
    expect(r.upside).toBe(92.9);
    expect(r.coverage).toBe(round2(7 / 9));
    expect(r.tier).toBe("A");
  });

  test("unknown is not zero: an empty judgement scores at the prior", () => {
    const r = computeScore(model, [], "full");
    expect(r.total).toBe(33.3);
    expect(r.coverage).toBe(0);
    expect(r.needs_check).toEqual(["size"]);
    expect(r.tier).toBe("C");
  });

  test("light mode uses only light factors and renormalizes groups", () => {
    const r = computeScore(model, j({ size: 3, industry: 3 }), "light");
    expect(r.total).toBe(100);
    expect(r.groups.intent).toBeNull();
    expect(r.coverage).toBe(1);
  });

  test("sanitize nulls levels without evidence", () => {
    const s = sanitizeJudgements([{ id: "size", level: 3, confidence: 0.9, evidence: [] }, { id: "industry", level: 2, confidence: 0.8, evidence: [{ quote: "q", source_url: "https://a.example" }] }]);
    expect(s[0]!.level).toBeNull();
    expect(s[1]!.level).toBe(2);
  });
});

const round2 = (x: number) => Math.round(x * 100) / 100;

describe("calibration", () => {
  const accounts: LabeledAccount[] = [
    { domain: "g1", label: "good", judged: j({ size: 3, industry: 3, trigger: 2, warm: 1 }) },
    { domain: "g2", label: "good", judged: j({ size: 3, industry: 2, trigger: 3, warm: 0 }) },
    { domain: "g3", label: "good", judged: j({ size: 2, industry: 3, trigger: 1, warm: 2 }) },
    { domain: "b1", label: "bad", judged: j({ size: 1, industry: 0, trigger: 1, warm: 0 }) },
    { domain: "b2", label: "bad", judged: j({ size: 2, industry: 1, trigger: 0, warm: 3 }) },
    { domain: "u1", label: null, judged: j({ size: 1, industry: 1, trigger: 1, warm: 1 }) },
    { domain: "u2", label: null, judged: j({ size: 2, industry: 2, trigger: 0, warm: 0 }) },
  ];
  test("backtest passes when goods outrank bads", () => {
    const b = backtest(model, accounts);
    expect(b).toMatchObject({ n_good: 3, n_bad: 2, n_unlabeled: 2, auc: 1, verdict: "pass", precision_at_k: 1 });
    expect(b.good_median_percentile).toBeGreaterThanOrEqual(75);
    expect(b.misranked).toEqual([]);
  });
  test("backtest flags misranked accounts and insufficient data", () => {
    const flipped = accounts.map((a) => ({ ...a, label: a.label === "good" ? ("bad" as const) : a.label === "bad" ? ("good" as const) : null }));
    const b = backtest(model, flipped);
    expect(b.verdict).toBe("insufficient_data"); // only 2 goods now
    expect(backtest(model, accounts.slice(0, 2)).verdict).toBe("insufficient_data");
  });
  test("sensitivity flags dead and dominant factors", () => {
    const s = sensitivity(model, accounts);
    expect(s.map((x) => x.factor)).toEqual(["size", "industry", "trigger", "warm"]);
    for (const x of s) {
      expect(x.tau_drop).toBeLessThanOrEqual(1);
      expect(x.tau_weight_up).toBeGreaterThan(0.5);
    }
    // a factor every account scores identically is dead weight
    const flat = accounts.map((a) => ({ ...a, judged: [...a.judged.filter((x) => x.id !== "warm"), { id: "warm", level: 2 as const, confidence: 1 }] }));
    expect(sensitivity(model, flat).find((x) => x.factor === "warm")?.flag).toBe("dead");
  });
  test("recalibrate proposes higher weight for the factor that predicts outcomes", () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
      const trig = i % 4;
      return { judged: [{ id: "size", level: (i % 2 ? 2 : 3) as 2 | 3 }, { id: "industry", level: 2 as const }, { id: "trigger", level: trig as 0 | 1 | 2 | 3 }, { id: "warm", level: 1 as const }], positive: trig >= 2 };
    });
    const p = recalibrate(model, rows);
    const trig = p.find((x) => x.factor === "trigger")!;
    expect(trig.proposed_weight).toBe(5);
    expect(trig.coefficient).toBeGreaterThan(p.find((x) => x.factor === "industry")!.coefficient);
  });
});
