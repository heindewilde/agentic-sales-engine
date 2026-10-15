import type { Op, OpInputs, ProviderName } from "./types.ts";

/**
 * Pessimistic pre-call cost estimates (USD), used for budget checks and the shortlist cost estimate.
 * Actual cost is recorded after the call when the provider reports it (Exa returns costDollars;
 * Firecrawl returns creditsUsed). Prices as of Oct 2026:
 *  - Exa search $5–7 / 1k requests (+$1 / 1k results beyond 10), contents/summary $1 / 1k pages,
 *    Agent flat per effort: minimal 0.012, low 0.025, medium 0.10, high 0.50, xhigh 1.00.
 *  - Firecrawl credits: scrape 1, JSON format +4, search 2 per 10 results. USD per credit depends on
 *    plan (Hobby ≈ $0.0038, Standard ≈ $0.00083); default assumes Hobby. Override with FIRECRAWL_USD_PER_CREDIT.
 */
export const EXA_AGENT_EFFORT_USD: Record<string, number> = { minimal: 0.012, low: 0.025, medium: 0.1, high: 0.5, xhigh: 1 };

export function firecrawlCreditUsd(): number {
  const v = Number(process.env.FIRECRAWL_USD_PER_CREDIT);
  return Number.isFinite(v) && v > 0 ? v : 0.004;
}

const exaSearch = (n: number, withContents: boolean) => 0.007 + Math.max(0, n - 10) * 0.001 + (withContents ? n * 0.001 : 0);

export function estimate<O extends Op>(provider: ProviderName, op: O, input: OpInputs[O]): number {
  const i = input as Record<string, unknown>;
  const n = Number(i.num_results ?? 10);
  const urls = Array.isArray(i.urls) ? i.urls.length : 0;
  const credit = firecrawlCreditUsd();
  const round = (x: number) => Math.round(x * 10000) / 10000;
  if (provider === "exa") {
    switch (op) {
      case "discover_companies":
        return round(exaSearch(n, i.with_summary !== false));
      case "find_people":
        return round(exaSearch(n, false));
      case "search_news":
        return round(exaSearch(n, true));
      case "fetch_pages":
      case "extract":
        return round(urls * 0.002);
      case "research":
        return EXA_AGENT_EFFORT_USD[String(i.effort ?? "medium")] ?? 0.5;
    }
  }
  switch (op) {
    case "fetch_pages":
      return round(urls * credit);
    case "extract":
      return round(urls * 5 * credit);
    case "search_news":
    case "discover_companies":
      return round(Math.ceil(n / 10) * 2 * credit);
    default:
      return round(300 * credit);
  }
}
