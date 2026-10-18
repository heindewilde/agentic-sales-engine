/** Line diff (longest common subsequence), for comparing versions of an agent prompt or skill. No dependency. */
export type DiffLine = { op: " " | "+" | "-"; text: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // lcs[i][j] = length of the LCS of x[i..] and y[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i++]! });
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", text: x[i++]! });
    else out.push({ op: "+", text: y[j++]! });
  }
  while (i < n) out.push({ op: "-", text: x[i++]! });
  while (j < m) out.push({ op: "+", text: y[j++]! });
  return out;
}

/** Only the changed lines, with a few lines of context around them. */
export function compactDiff(d: DiffLine[], context = 2): (DiffLine | { op: "…"; text: string })[] {
  const keep = new Set<number>();
  d.forEach((l, k) => {
    if (l.op !== " ") for (let c = k - context; c <= k + context; c++) keep.add(c);
  });
  const out: (DiffLine | { op: "…"; text: string })[] = [];
  let skipped = 0;
  d.forEach((l, k) => {
    if (keep.has(k)) {
      if (skipped) out.push({ op: "…", text: `${skipped} unchanged lines` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ op: "…", text: `${skipped} unchanged lines` });
  return out;
}
