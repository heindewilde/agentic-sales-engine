import type { Company, Factor, FactorScore, Level } from "./schemas.ts";

/**
 * Rule-based judging for factors whose anchors are numeric ranges over a known fact (e.g. company size from
 * the `employees` fact). Cheaper than an LLM call and perfectly consistent. In scoring.yaml:
 *
 *   - id: company_size
 *     auto: { fact: employees, levels: { 0: "<50 | >5000", 1: "50-99 | 1001-5000", 2: "100-149 | 701-1000", 3: "150-700" } }
 *
 * Range syntax per level: "a-b", "<a", "<=a", ">a", ">=a", "a+" — alternatives separated by "|".
 */

export interface AutoRule {
  fact: string;
  levels: Partial<Record<"0" | "1" | "2" | "3", string>>;
}

/** Parse "12", "1,200", "~310", "250-300" (midpoint), "approximately 310 employees" → number. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s](?=\d{3}\b)/g, "").replace(/[~≈]/g, "");
  const range = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/.exec(s);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const m = /(\d+(?:\.\d+)?)\s*(k|m)?\b/i.exec(s);
  if (!m) return null;
  const mult = m[2]?.toLowerCase() === "k" ? 1_000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return Number(m[1]) * mult;
}

export function inRange(n: number, spec: string): boolean {
  return spec.split("|").some((part) => {
    const p = part.trim().replace(/\s+/g, "");
    let m: RegExpExecArray | null;
    if ((m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(p))) return n >= Number(m[1]) && n <= Number(m[2]);
    if ((m = /^<=(\d+(?:\.\d+)?)$/.exec(p))) return n <= Number(m[1]);
    if ((m = /^<(\d+(?:\.\d+)?)$/.exec(p))) return n < Number(m[1]);
    if ((m = /^>=(\d+(?:\.\d+)?)$/.exec(p))) return n >= Number(m[1]);
    if ((m = /^>(\d+(?:\.\d+)?)$/.exec(p))) return n > Number(m[1]);
    if ((m = /^(\d+(?:\.\d+)?)\+$/.exec(p))) return n >= Number(m[1]);
    if ((m = /^(\d+(?:\.\d+)?)$/.exec(p))) return n === Number(m[1]);
    return false;
  });
}

/** Judge one auto factor from the company's facts; null when the fact is missing or matches no level. */
export function autoJudge(factor: Factor & { auto?: AutoRule }, company: Pick<Company, "facts">): FactorScore | null {
  const rule = factor.auto;
  if (!rule) return null;
  const fact = company.facts?.[rule.fact];
  if (!fact) return null;
  const n = parseNumber(fact.value);
  if (n === null) return null;
  for (const lvl of ["3", "2", "1", "0"] as const) {
    const spec = rule.levels[lvl];
    if (spec && inRange(n, spec)) {
      return {
        id: factor.id,
        level: Number(lvl) as Level,
        confidence: fact.confidence,
        evidence: [{ quote: `${rule.fact}: ${String(fact.value)}`, source_url: fact.source_url }],
        rationale: `rule: ${rule.fact} ${n} is in "${spec}" (level ${lvl})`,
      };
    }
  }
  return null;
}
