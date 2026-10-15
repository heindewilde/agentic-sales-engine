import type { Company, Factor, FactorScore, Level, Signal } from "./schemas.ts";

/**
 * Rule-based judging for factors whose anchors are numeric ranges over a known fact (e.g. company size from
 * the `employees` fact). Cheaper than an LLM call and perfectly consistent. In scoring.yaml:
 *
 *   - id: company_size
 *     auto: { fact: employees, levels: { 0: "<50 | >5000", 1: "50-99 | 1001-5000", 2: "100-149 | 701-1000", 3: "150-700" } }
 *
 * Range syntax per level: "a-b", "<a", "<=a", ">a", ">=a", "a+" — alternatives separated by "|".
 *
 * Time-window intent factors can count dated signals instead (signals are typed and dated during research):
 *
 *   - id: growth_move
 *     auto: { signals: { types: [expansion, funding, mna], within_days: 365 }, levels: { 0: "0", 2: "1", 3: ">=2" } }
 *
 * A count of 0 only counts as level 0 once the account has been researched (someone searched the news);
 * before that the factor stays unknown.
 */

export interface AutoRule {
  fact?: string;
  signals?: { types: string[]; within_days: number };
  levels: Partial<Record<"0" | "1" | "2" | "3", string>>;
}

export interface AutoContext {
  signals?: Pick<Signal, "type" | "date" | "title" | "source_url" | "raw_ref" | "status">[];
  /** research has run for this account (a news search was done), so "no signals" is a verified absence */
  researched?: boolean;
  today?: string;
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
export function autoJudge(factor: Factor & { auto?: AutoRule }, company: Pick<Company, "facts">, ctx: AutoContext = {}): FactorScore | null {
  const rule = factor.auto;
  if (!rule) return null;
  if (rule.signals) return signalJudge(factor.id, rule as AutoRule & { signals: NonNullable<AutoRule["signals"]> }, ctx);
  if (!rule.fact) return null;
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

function signalJudge(id: string, rule: AutoRule & { signals: NonNullable<AutoRule["signals"]> }, ctx: AutoContext): FactorScore | null {
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const since = new Date(Date.parse(today) - rule.signals.within_days * 86_400_000).toISOString().slice(0, 10);
  const hits = (ctx.signals ?? []).filter((s) => rule.signals.types.includes(s.type) && s.status !== "stale" && s.date >= since && s.date <= today);
  if (!hits.length && !ctx.researched) return null;
  for (const lvl of ["3", "2", "1", "0"] as const) {
    const spec = rule.levels[lvl];
    if (!spec || !inRange(hits.length, spec)) continue;
    const evidence = hits.length
      ? hits.slice(0, 5).map((h) => ({ quote: `${h.date}: ${h.title}`, source_url: h.source_url, ...(h.raw_ref ? { raw_ref: h.raw_ref } : {}) }))
      : [{ quote: `no ${rule.signals.types.join("/")} signals since ${since} after a news search — not found`, source_url: "import:signals", checked: true as const }];
    return {
      id,
      level: Number(lvl) as Level,
      confidence: hits.length ? 0.8 : 0.6,
      evidence,
      rationale: `rule: ${hits.length} ${rule.signals.types.join("/")} signal(s) since ${since} is in "${spec}" (level ${lvl})`,
    };
  }
  return null;
}
