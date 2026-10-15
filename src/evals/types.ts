/**
 * Eval result contract — the same shape OpenEvals uses ({ key, score, comment }), so results can be pushed
 * to Langfuse / LangSmith datasets unchanged. Scores are 0..1 (fraction of checks passed) or booleans.
 */
export interface EvalResult {
  key: string;
  /** subject of the evaluation, e.g. "accounts/acme.com/brief.md" */
  target: string;
  score: number | boolean | null;
  comment: string;
  /** individual failed checks, for the report */
  failures?: string[];
  /** USD spent by LLM-as-judge evaluators */
  cost_usd?: number;
}

export interface SuiteResult {
  suite: "offline" | "llm";
  workspace: string;
  ran_at: string;
  results: EvalResult[];
  summary: Record<string, { mean: number | null; n: number; min: number | null }>;
  cost_usd: number;
}

export function summarize(results: EvalResult[]): SuiteResult["summary"] {
  const by: Record<string, number[]> = {};
  for (const r of results) {
    if (r.score === null) continue;
    (by[r.key] ??= []).push(typeof r.score === "boolean" ? (r.score ? 1 : 0) : r.score);
  }
  const out: SuiteResult["summary"] = {};
  for (const [k, xs] of Object.entries(by)) {
    out[k] = { mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000, n: xs.length, min: Math.min(...xs) };
  }
  for (const r of results) if (!(r.key in out)) out[r.key] = { mean: null, n: 0, min: null };
  return out;
}
