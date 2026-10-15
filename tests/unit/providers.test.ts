import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringifyDoc } from "../../src/core/frontmatter.ts";
import { readLedger } from "../../src/core/ledger.ts";
import { cassetteKey, stableJson } from "../../src/core/providers/cassette.ts";
import { mapCompany, mapPerson } from "../../src/core/providers/exa.ts";
import { tbsRange } from "../../src/core/providers/firecrawl.ts";
import { callProvider, estimateCall, writeRaw } from "../../src/core/providers/gateway.ts";
import { estimate } from "../../src/core/providers/pricing.ts";
import type { Adapter, AdapterResult, Op, OpInputs } from "../../src/core/providers/types.ts";
import { fact, makeWorkspace } from "../helpers.ts";

/** Fake adapter that returns canned results and records calls. */
function fake(name: "exa" | "firecrawl", supports: Op[], results: Partial<Record<Op, unknown>>, cost = 0.01): Adapter & { calls: { op: Op; input: unknown }[] } {
  const calls: { op: Op; input: unknown }[] = [];
  return {
    name,
    supports,
    calls,
    async run<O extends Op>(op: O, input: OpInputs[O]): Promise<AdapterResult<O>> {
      calls.push({ op, input });
      return { results: structuredClone(results[op]) as AdapterResult<O>["results"], cost_usd: cost, cost_kind: "actual" };
    },
  };
}

const companies = [
  { name: "Brightline Foods", domain: "brightline-foods.example", url: "https://brightline-foods.example", description: "Food wholesaler" },
  { name: "Northwind Cargo", domain: "northwind-cargo.example", url: "https://northwind-cargo.example" },
  { name: "Kessler Armaturen", domain: "kessler-armaturen.example", url: "https://kessler-armaturen.example" },
];

const wsWith = (files: Record<string, string> = {}) =>
  makeWorkspace({ "dnc.yaml": "entries:\n  - { kind: domain, value: northwind-cargo.example, reason: customer }\n", ...files });

describe("gateway", () => {
  test("filters DNC, marks known accounts, writes raw snapshot and ledger", async () => {
    const ws = wsWith({
      "accounts/kessler-armaturen.example/company.md": stringifyDoc({ id: "kessler-armaturen.example", name: "Kessler", facts: { x: fact(1) } }),
    });
    const exa = fake("exa", ["discover_companies"], { discover_companies: companies }, 0.023);
    const r = await callProvider("discover_companies", { query: "food wholesalers in Belgium" }, { ws, adapters: { exa, firecrawl: null }, mode: "live" });
    expect(r.provider).toBe("exa");
    expect(r.results.map((c) => c.domain)).toEqual(["brightline-foods.example", "kessler-armaturen.example"]);
    expect(r.dropped_dnc).toBe(1);
    expect(r.results.find((c) => c.domain === "kessler-armaturen.example")?.known).toBe(true);
    expect(r.raw_ref).toMatch(/^raw\/\d{4}-\d{2}\/[0-9a-f]{12}\.md$/);
    expect(readFileSync(join(ws, r.raw_ref!), "utf8")).toContain("Brightline Foods");
    const ledger = readLedger(ws);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ provider: "exa", op: "discover_companies", usd: 0.023, kind: "actual" });
    expect(r.budget.day_spent_usd).toBe(0.023);
  });

  test("routes by config preference and falls back when the preferred provider is missing", async () => {
    const ws = wsWith();
    const exa = fake("exa", ["fetch_pages"], { fetch_pages: [{ url: "https://a.example", text: "hello" }] });
    const fc = fake("firecrawl", ["fetch_pages"], { fetch_pages: [{ url: "https://a.example", text: "hello" }] });
    // default config: extract/fetch prefer firecrawl
    expect((await callProvider("fetch_pages", { urls: ["https://a.example"] }, { ws, adapters: { exa, firecrawl: fc }, mode: "live" })).provider).toBe("firecrawl");
    expect((await callProvider("fetch_pages", { urls: ["https://a.example"] }, { ws, adapters: { exa, firecrawl: null }, mode: "live" })).provider).toBe("exa");
    expect((await callProvider("fetch_pages", { urls: ["https://a.example"] }, { ws, adapters: { exa, firecrawl: fc }, mode: "live", provider: "exa" })).provider).toBe("exa");
  });

  test("no provider → actionable error pointing at built-in tools", async () => {
    const ws = wsWith();
    await expect(callProvider("discover_companies", { query: "x companies" }, { ws, adapters: { exa: null, firecrawl: null }, mode: "live" })).rejects.toThrow(/WebSearch/);
    const fc = fake("firecrawl", ["fetch_pages", "extract", "search_news"], {});
    await expect(callProvider("find_people", { query: "CFO at Acme" }, { ws, adapters: { exa: null, firecrawl: fc }, mode: "live" })).rejects.toMatchObject({ code: "no_provider" });
  });

  test("budget gate: daily cap, run cap and unbudgeted expensive calls", async () => {
    const ws = wsWith(); // test config: per_day_usd 2
    const exa = fake("exa", ["research", "discover_companies"], { research: { text: "x", structured: null, citations: [] }, discover_companies: [] }, 0.4);
    // research at high effort ($0.50 est) without a run: allowed only up to the unbudgeted cap
    await expect(callProvider("research", { instructions: "Research Acme thoroughly please", effort: "xhigh" }, { ws, adapters: { exa }, mode: "live" })).rejects.toMatchObject({ code: "budget" });
    await callProvider("research", { instructions: "Research Acme thoroughly please", effort: "high" }, { ws, adapters: { exa }, mode: "live" });
    // run with tiny budget
    Bun.spawnSync(["bun", join(import.meta.dir, "../../src/cli/ase.ts"), "ledger", "run", "start", "--stage", "research", "--budget", "0.3", "--workspace", ws]);
    await expect(callProvider("research", { instructions: "Research Acme thoroughly please", effort: "high" }, { ws, adapters: { exa }, mode: "live" })).rejects.toThrow(/Run .* budget reached/);
    // the refused call recorded nothing
    expect(readLedger(ws)).toHaveLength(1);
  });

  test("daily cap blocks once reached", async () => {
    const ws = wsWith();
    const exa = fake("exa", ["discover_companies"], { discover_companies: [] }, 1.99);
    await callProvider("discover_companies", { query: "anything at all" }, { ws, adapters: { exa }, mode: "live" });
    await expect(callProvider("discover_companies", { query: "anything at all" }, { ws, adapters: { exa }, mode: "live" })).rejects.toThrow(/Daily budget/);
  });

  test("validates input", async () => {
    const ws = wsWith();
    const exa = fake("exa", ["search_news"], { search_news: [] });
    await expect(callProvider("search_news", { query: "acme funding", since: "last week" }, { ws, adapters: { exa }, mode: "live" })).rejects.toMatchObject({ code: "bad_input" });
  });

  test("news and pages get per-item raw_refs; DNC news domains dropped", async () => {
    const ws = wsWith();
    const exa = fake("exa", ["search_news"], {
      search_news: [
        { title: "Brightline raises €12M", url: "https://news.example/a", published: "2026-09-30", summary: "Funding round" },
        { title: "Northwind blog", url: "https://northwind-cargo.example/blog", published: "2026-09-01", summary: "x" },
      ],
    });
    const r = await callProvider("search_news", { query: "Brightline funding", since: "2026-01-01" }, { ws, adapters: { exa }, mode: "live" });
    expect(r.results).toHaveLength(1);
    const ref = (r.results[0] as { raw_ref?: string }).raw_ref!;
    expect(existsSync(join(ws, ref))).toBe(true);
    expect(readFileSync(join(ws, ref), "utf8")).toContain("url: https://news.example/a");
  });

  test("estimateCall picks provider and cost without calling", async () => {
    const ws = wsWith();
    const exa = fake("exa", ["research"], {});
    expect(await estimateCall("research", { instructions: "a long enough question", effort: "high" }, { ws, adapters: { exa }, mode: "live" })).toEqual({ provider: "exa", est_usd: 0.5 });
    expect(exa.calls).toHaveLength(0);
  });
});

describe("cassettes", () => {
  test("record then replay returns identical results without the real adapter", async () => {
    const ws = wsWith();
    const dir = mkdtempSync(join(tmpdir(), "ase-cas-"));
    const exa = fake("exa", ["discover_companies"], { discover_companies: companies.slice(0, 1) });
    const input = { query: "food wholesalers", num_results: 5 };
    const rec = await callProvider("discover_companies", input, { ws, adapters: { exa }, mode: "record", cassettes: dir });
    expect(readdirSync(dir)).toEqual([`${cassetteKey("exa", "discover_companies", input)}.json`]);
    const rep = await callProvider("discover_companies", { num_results: 5, query: "food wholesalers" }, { ws, adapters: { exa: null }, mode: "replay", cassettes: dir });
    expect(rep.results).toEqual(rec.results);
    expect(exa.calls).toHaveLength(1);
    await expect(callProvider("discover_companies", { query: "something else" }, { ws, adapters: { exa: null }, mode: "replay", cassettes: dir })).rejects.toMatchObject({ code: "replay_miss" });
  });
  test("stableJson ignores key order and undefined", () => {
    expect(stableJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });
});

describe("raw snapshots", () => {
  test("content-addressed and write-once", () => {
    const ws = makeWorkspace();
    const a = writeRaw(ws, { url: "https://x.example" }, "hello");
    const b = writeRaw(ws, { url: "https://x.example" }, "hello");
    expect(a).toBe(b);
    expect(writeRaw(ws, { url: "https://x.example" }, "changed")).not.toBe(a);
  });
});

describe("adapters' mapping", () => {
  test("exa company entity", () => {
    const c = mapCompany({
      title: "Brightline Foods | Wholesale", url: "https://www.brightline-foods.example/en",
      entities: [{ type: "company", properties: { name: "Brightline Foods NV", workforce: { total: 320 }, headquarters: { country: "BE", city: "Ghent" }, foundedYear: 1987 } }],
    });
    expect(c).toMatchObject({ name: "Brightline Foods NV", domain: "brightline-foods.example", employees: 320, hq_country: "BE", hq_city: "Ghent", founded: 1987 });
  });
  test("exa person entity picks the current job", () => {
    const p = mapPerson({
      title: "Jane Doe - CFO", url: "https://be.linkedin.com/in/jane-doe-12",
      entities: [{ type: "person", properties: { name: "Jane Doe", workHistory: [
        { title: "Controller", company: { name: "Old Co" }, dates: { from: "2015", to: "2020" } },
        { title: "CFO", company: { name: "Brightline Foods" }, dates: { from: "2020", to: null } },
      ] } }],
    });
    expect(p).toMatchObject({ name: "Jane Doe", title: "CFO", company: "Brightline Foods", linkedin_url: "https://www.linkedin.com/in/jane-doe-12" });
  });
  test("firecrawl date window", () => {
    expect(tbsRange("2026-01-05", "2026-10-15")).toBe("cdr:1,cd_min:1/5/2026,cd_max:10/15/2026");
  });
  test("pricing", () => {
    expect(estimate("exa", "research", { instructions: "x", effort: "xhigh" })).toBe(1);
    expect(estimate("exa", "discover_companies", { query: "x", num_results: 25 })).toBeCloseTo(0.047);
    expect(estimate("firecrawl", "extract", { urls: ["a", "b"], schema: {} })).toBeCloseTo(0.04);
  });
});
