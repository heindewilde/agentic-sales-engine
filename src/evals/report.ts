import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteResult } from "./types.ts";

/** Saved under <workspace>/evals/ so trends are visible in git history. */
export function saveResult(ws: string, r: SuiteResult): string {
  const dir = join(ws, "evals");
  mkdirSync(dir, { recursive: true });
  const rel = `evals/${r.ran_at.slice(0, 19).replace(/[:T]/g, "-")}-${r.suite}.json`;
  writeFileSync(join(ws, rel), `${JSON.stringify(r, null, 2)}\n`);
  return rel;
}

export function latestResult(ws: string, suite: SuiteResult["suite"], exclude?: string): SuiteResult | null {
  const dir = join(ws, "evals");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(`-${suite}.json`) && `evals/${f}` !== exclude).sort();
  const last = files.at(-1);
  return last ? (JSON.parse(readFileSync(join(dir, last), "utf8")) as SuiteResult) : null;
}

/** Per-evaluator mean change vs a baseline; a drop of more than `tolerance` is a regression. */
export function compare(current: SuiteResult, baseline: SuiteResult | null, tolerance = 0.05) {
  const rows: { key: string; baseline: number | null; current: number | null; delta: number | null; regression: boolean }[] = [];
  for (const [key, s] of Object.entries(current.summary)) {
    const b = baseline?.summary[key]?.mean ?? null;
    const delta = b !== null && s.mean !== null ? Math.round((s.mean - b) * 1000) / 1000 : null;
    rows.push({ key, baseline: b, current: s.mean, delta, regression: delta !== null && delta < -tolerance });
  }
  return { baseline_ran_at: baseline?.ran_at ?? null, regressions: rows.filter((r) => r.regression).map((r) => r.key), rows };
}

export function formatReport(r: SuiteResult, cmp: ReturnType<typeof compare>): string {
  const lines = [`Eval suite "${r.suite}" — ${r.results.length} checks${r.cost_usd ? `, $${r.cost_usd.toFixed(3)}` : ""}`];
  for (const row of cmp.rows) {
    const cur = row.current === null ? "n/a" : row.current.toFixed(2);
    const d = row.delta === null ? "" : ` (${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(2)} vs baseline)`;
    lines.push(`  ${row.regression ? "✗" : "•"} ${row.key.padEnd(22)} ${cur}${d}`);
  }
  const worst = r.results.filter((x) => x.failures?.length).slice(0, 8);
  if (worst.length) {
    lines.push("", "Failures:");
    for (const w of worst) for (const f of w.failures!.slice(0, 3)) lines.push(`  - ${w.key} · ${w.target}: ${f}`);
  }
  if (cmp.regressions.length) lines.push("", `REGRESSIONS: ${cmp.regressions.join(", ")}`);
  return lines.join("\n");
}
