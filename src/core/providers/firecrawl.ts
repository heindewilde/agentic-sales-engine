import Firecrawl from "@mendable/firecrawl-js";
import { firecrawlCreditUsd, estimate } from "./pricing.ts";
import type { Adapter, AdapterResult, ExtractHit, NewsHit, Op, OpInputs, PageHit } from "./types.ts";

/** Run async jobs with bounded concurrency, preserving order. Failed items return null. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        out[idx] = await fn(items[idx]!);
      } catch {
        out[idx] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Map an ISO date window to Google-style tbs custom date range (Firecrawl web search). */
export function tbsRange(since: string, until?: string): string {
  const f = (s: string) => {
    const d = new Date(s);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  };
  return `cdr:1,cd_min:${f(since)},cd_max:${f(until ?? new Date().toISOString())}`;
}

export function firecrawlAdapter(apiKey: string | undefined, apiUrl?: string): Adapter {
  const fc = new Firecrawl({ apiKey: apiKey || null, apiUrl: apiUrl || null });
  const credit = firecrawlCreditUsd();
  return {
    name: "firecrawl",
    // No company/people index: discovery and people search go to Exa (or built-in web search at T0).
    supports: ["fetch_pages", "extract", "search_news"],
    async run<O extends Op>(op: O, input: OpInputs[O]): Promise<AdapterResult<O>> {
      const est = estimate("firecrawl", op, input);
      switch (op) {
        case "fetch_pages": {
          const i = input as OpInputs["fetch_pages"];
          const docs = await pool(i.urls, 4, (url) => fc.scrape(url, { formats: ["markdown"], onlyMainContent: true }));
          let credits = 0;
          const results: PageHit[] = [];
          docs.forEach((d, idx) => {
            if (!d) return;
            credits += d.metadata?.creditsUsed ?? 1;
            results.push({ url: d.metadata?.sourceURL ?? i.urls[idx]!, title: d.metadata?.title ?? null, text: (d.markdown ?? "").slice(0, i.max_chars ?? 8000) });
          });
          return { results, cost_usd: credits * credit, cost_kind: "actual" } as AdapterResult<O>;
        }
        case "extract": {
          const i = input as OpInputs["extract"];
          const docs = await pool(i.urls, 4, (url) =>
            fc.scrape(url, { formats: [{ type: "json", schema: i.schema, prompt: i.prompt }], onlyMainContent: true }),
          );
          let credits = 0;
          const results: ExtractHit[] = [];
          docs.forEach((d, idx) => {
            if (!d) return;
            credits += d.metadata?.creditsUsed ?? 5;
            results.push({ url: d.metadata?.sourceURL ?? i.urls[idx]!, data: d.json ?? null });
          });
          return { results, cost_usd: credits * credit, cost_kind: "actual" } as AdapterResult<O>;
        }
        case "search_news": {
          const i = input as OpInputs["search_news"];
          // Firecrawl's date filter (tbs) applies to web results only, so search web with a date window.
          const r = await fc.search(i.query, { limit: i.num_results ?? 10, sources: ["web"], tbs: tbsRange(i.since, i.until) });
          const results: NewsHit[] = (r.web ?? []).map((w: any) => ({
            title: w.title ?? w.metadata?.title ?? w.url,
            url: w.url ?? w.metadata?.sourceURL,
            published: w.date ?? null,
            summary: w.description ?? w.snippet ?? null,
          }));
          return { results, cost_usd: est, cost_kind: "est" } as AdapterResult<O>;
        }
      }
      throw new Error(`firecrawl adapter does not support ${op}`);
    },
  };
}
