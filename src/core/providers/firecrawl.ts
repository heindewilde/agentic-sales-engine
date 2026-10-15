import Firecrawl from "@mendable/firecrawl-js";
import { firecrawlCreditUsd, estimate } from "./pricing.ts";
import type { Adapter, AdapterResult, ExtractHit, NewsHit, Op, OpInputs, PageHit } from "./types.ts";

/** Run async jobs with bounded concurrency, preserving order. A failed item becomes `{ error }`. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<(R | { error: string })[]> {
  const out: (R | { error: string })[] = new Array(items.length).fill({ error: "not run" });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        out[idx] = await fn(items[idx]!);
      } catch (e) {
        out[idx] = { error: ((e as Error).message || "request failed").slice(0, 200) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type Scraped = { markdown?: string; json?: unknown; metadata?: { sourceURL?: string; url?: string; title?: string; creditsUsed?: number; statusCode?: number; error?: string } };
const path = (u: string) => {
  try {
    return new URL(u).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return u;
  }
};
/** A scrape that threw, returned an HTTP error, or came back empty is a failure the caller must see. */
export function scrapeFailure(d: Scraped | { error: string }, needText: boolean): string | null {
  if ("error" in d && typeof d.error === "string" && !("metadata" in d)) return d.error;
  const s = d as Scraped;
  const code = s.metadata?.statusCode;
  if (code && code >= 400) return `HTTP ${code}${code === 404 ? " (page does not exist — find the real URL from the site's navigation)" : ""}`;
  if (needText && !(s.markdown ?? "").trim()) return "empty page";
  // A deep link that lands on the homepage means the page doesn't exist (common for guessed /careers URLs).
  const asked = s.metadata?.sourceURL, landed = s.metadata?.url;
  if (asked && landed && path(asked) !== "/" && path(landed) === "/") return `redirected to the homepage (${landed}) — the page does not exist`;
  return null;
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
          const failed: { url: string; reason: string }[] = [];
          docs.forEach((d0, idx) => {
            const d = d0 as Scraped;
            if (!("error" in d0 && !("metadata" in d0))) credits += d.metadata?.creditsUsed ?? 1;
            const why = scrapeFailure(d0 as Scraped | { error: string }, true);
            if (why) return void failed.push({ url: i.urls[idx]!, reason: why });
            results.push({ url: d.metadata?.sourceURL ?? i.urls[idx]!, title: d.metadata?.title ?? null, text: (d.markdown ?? "").slice(0, i.max_chars ?? 8000) });
          });
          return { results, failed, cost_usd: credits * credit, cost_kind: "actual" } as AdapterResult<O>;
        }
        case "extract": {
          const i = input as OpInputs["extract"];
          const docs = await pool(i.urls, 4, (url) =>
            fc.scrape(url, { formats: [{ type: "json", schema: i.schema, prompt: i.prompt }], onlyMainContent: true }),
          );
          let credits = 0;
          const results: ExtractHit[] = [];
          const failed: { url: string; reason: string }[] = [];
          docs.forEach((d0, idx) => {
            const d = d0 as Scraped;
            if (!("error" in d0 && !("metadata" in d0))) credits += d.metadata?.creditsUsed ?? 5;
            const why = scrapeFailure(d0 as Scraped | { error: string }, false);
            if (why) return void failed.push({ url: i.urls[idx]!, reason: why });
            results.push({ url: d.metadata?.sourceURL ?? i.urls[idx]!, data: d.json ?? null });
          });
          return { results, failed, cost_usd: credits * credit, cost_kind: "actual" } as AdapterResult<O>;
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
