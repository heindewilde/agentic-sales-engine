/** Small, dependency-free statistics used for scoring calibration. Every function is unit-tested against known values. */

/**
 * Area under the ROC curve: probability that a random positive scores higher than a random negative
 * (ties count half). Mann–Whitney formulation, O(n log n).
 */
export function auc(scores: number[], labels: boolean[]): number | null {
  const pairs = scores.map((s, i) => ({ s, y: labels[i]! })).sort((a, b) => a.s - b.s);
  const nPos = pairs.filter((p) => p.y).length;
  const nNeg = pairs.length - nPos;
  if (nPos === 0 || nNeg === 0) return null;
  // average ranks for ties
  let rankSumPos = 0;
  for (let i = 0; i < pairs.length; ) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1]!.s === pairs[i]!.s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (pairs[k]!.y) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Kendall's tau-b between two score vectors over the same items (1 = identical order, -1 = reversed). */
export function kendallTau(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  let tiesA = 0;
  let tiesB = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const da = Math.sign(a[i]! - a[j]!);
      const db = Math.sign(b[i]! - b[j]!);
      if (da === 0 && db === 0) continue;
      if (da === 0) tiesA++;
      else if (db === 0) tiesB++;
      else if (da === db) concordant++;
      else discordant++;
    }
  }
  const denom = Math.sqrt((concordant + discordant + tiesA) * (concordant + discordant + tiesB));
  return denom === 0 ? 1 : (concordant - discordant) / denom;
}

/** Percentile rank (0–100) of `value` within `population`: share strictly below plus half the ties. */
export function percentileRank(value: number, population: number[]): number {
  if (population.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const p of population) {
    if (p < value) below++;
    else if (p === value) equal++;
  }
  return ((below + equal / 2) / population.length) * 100;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Share of the top-k items (by score) that are positive. */
export function precisionAtK(scores: number[], labels: boolean[], k: number): number | null {
  if (scores.length === 0 || k <= 0) return null;
  const top = scores
    .map((s, i) => ({ s, y: labels[i]! }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  return top.filter((t) => t.y).length / top.length;
}

/**
 * L2-regularized logistic regression by batch gradient descent on standardized-free inputs (factor
 * levels are already on a 0–3 scale). Returns intercept + one coefficient per column.
 */
export function logisticRegression(
  X: number[][],
  y: number[],
  opts: { l2?: number; lr?: number; iterations?: number } = {},
): { intercept: number; coef: number[] } {
  const l2 = opts.l2 ?? 0.1;
  const lr = opts.lr ?? 0.1;
  const iters = opts.iterations ?? 5000;
  const n = X.length;
  const d = X[0]?.length ?? 0;
  let b = 0;
  const w = new Array<number>(d).fill(0);
  for (let it = 0; it < iters; it++) {
    let gb = 0;
    const gw = new Array<number>(d).fill(0);
    for (let i = 0; i < n; i++) {
      const row = X[i]!;
      let z = b;
      for (let k = 0; k < d; k++) z += w[k]! * row[k]!;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i]!;
      gb += err;
      for (let k = 0; k < d; k++) gw[k]! += err * row[k]!;
    }
    b -= (lr * gb) / n;
    for (let k = 0; k < d; k++) w[k] = w[k]! - lr * (gw[k]! / n + l2 * w[k]!);
  }
  return { intercept: b, coef: w };
}
