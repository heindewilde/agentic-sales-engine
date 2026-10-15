/**
 * Live provider smoke tests — real API calls (~$0.05 per run). Skipped unless ASE_LIVE=1.
 *   ASE_LIVE=1 bun test tests/live
 * Keys come from the environment or ~/.config/agentic-sales-engine/credentials.env (`ase keys status`).
 */
import { describe, expect, test } from "bun:test";
import { loadCredentials } from "../../src/core/credentials.ts";
import { readLedger } from "../../src/core/ledger.ts";
import { callProvider } from "../../src/core/providers/gateway.ts";
import { makeWorkspace } from "../helpers.ts";

const LIVE = process.env.ASE_LIVE === "1";
if (LIVE) loadCredentials();
const ws = LIVE ? makeWorkspace() : "";
const opts = { ws, mode: "live" as const };
const t = LIVE ? test : test.skip;

describe("exa (live)", () => {
  t("discover_companies maps company entities", async () => {
    const r = await callProvider("discover_companies", { query: "food wholesale distributors in Belgium", num_results: 5, country: "BE" }, { ...opts, provider: "exa" });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((c) => c.domain && c.name)).toBe(true);
    expect(r.cost_kind).toBe("actual");
  }, 60_000);
  t("find_people returns LinkedIn profiles with current title", async () => {
    const r = await callProvider("find_people", { query: "CFO at Colruyt Group", num_results: 3 }, { ...opts, provider: "exa" });
    expect(r.results.some((p) => p.linkedin_url?.startsWith("https://www.linkedin.com/in/") && p.title)).toBe(true);
  }, 60_000);
  t("search_news respects the date window", async () => {
    const r = await callProvider("search_news", { query: "Belgium acquisition wholesaler", since: "2026-01-01", num_results: 3 }, { ...opts, provider: "exa" });
    expect(r.results.every((n) => !n.published || n.published >= "2026-01-01")).toBe(true);
  }, 60_000);
  t("research agent returns structured output with citations", async () => {
    const r = await callProvider("research", { instructions: "What year was Colruyt Group founded? Cite a source.", effort: "minimal", output_schema: { type: "object", properties: { founded_year: { type: "number" } } } }, { ...opts, provider: "exa" });
    expect(r.results.citations.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("firecrawl (live)", () => {
  t("fetch_pages and extract", async () => {
    const f = await callProvider("fetch_pages", { urls: ["https://www.firecrawl.dev/pricing"], max_chars: 500 }, { ...opts, provider: "firecrawl" });
    expect(f.results[0]!.text.length).toBeGreaterThan(50);
    const x = await callProvider("extract", { urls: ["https://www.firecrawl.dev/pricing"], schema: { type: "object", properties: { plans: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } } } }, { ...opts, provider: "firecrawl" });
    expect(Array.isArray((x.results[0]!.data as { plans?: unknown[] })?.plans)).toBe(true);
  }, 120_000);
  t("ledger recorded every call", () => {
    expect(readLedger(ws).length).toBeGreaterThanOrEqual(6);
  });
});
