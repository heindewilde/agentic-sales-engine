import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { persistCandidates } from "../../src/core/accounts.ts";
import { applyUpdates, footnoteClashes, rebuildBrief } from "../../src/core/apply.ts";
import { writeRaw } from "../../src/core/providers/gateway.ts";
import { autoJudge, inRange, parseNumber } from "../../src/core/autojudge.ts";
import { buildContext } from "../../src/core/context.ts";
import { focusText } from "../../src/core/focus.ts";
import { readDoc } from "../../src/core/frontmatter.ts";
import { lint } from "../../src/core/lint.ts";
import type { Company } from "../../src/core/schemas.ts";
import { Scoring } from "../../src/core/schemas.ts";
import { runOffline } from "../../src/evals/offline.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const fixture = () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-ef-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  // give company_size a rule
  const p = join(ws, `icps/${ICP}/scoring.yaml`);
  const doc = YAML.parse(readFileSync(p, "utf8"));
  doc.factors.find((f: { id: string }) => f.id === "company_size").auto = { fact: "employees", levels: { 0: "<50 | >5000", 1: "50-99 | 1001-5000", 2: "100-149 | 701-1000", 3: "150-700" } };
  writeFileSync(p, YAML.stringify(doc));
  return ws;
};

describe("rule-based factors", () => {
  test("parseNumber and ranges", () => {
    expect(parseNumber("approximately 310 employees")).toBe(310);
    expect(parseNumber("1,200")).toBe(1200);
    expect(parseNumber("250-300")).toBe(275);
    expect(parseNumber("2.5k")).toBe(2500);
    expect(parseNumber("unknown")).toBeNull();
    expect(inRange(40, "<50 | >5000")).toBe(true);
    expect(inRange(6000, "<50 | >5000")).toBe(true);
    expect(inRange(310, "150-700")).toBe(true);
    expect(inRange(800, "500+")).toBe(true);
  });
  test("autoJudge picks the matching level with the fact as evidence", () => {
    const scoring = Scoring.parse(YAML.parse(readFileSync(join(fixture(), `icps/${ICP}/scoring.yaml`), "utf8")));
    const f = scoring.factors.find((x) => x.id === "company_size")!;
    expect(f.auto?.fact).toBe("employees");
    const j = autoJudge(f, { facts: { employees: { value: 320, source_url: "https://a.example/about", retrieved_at: "2026-10-01", confidence: 0.9 } } });
    expect(j).toMatchObject({ level: 3, confidence: 0.9, evidence: [{ quote: "employees: 320", source_url: "https://a.example/about" }] });
    expect(autoJudge(f, { facts: {} })).toBeNull();
  });
});

describe("focused excerpts", () => {
  test("keeps relevant paragraphs within budget, in order", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Our product range number ${i} includes many lovely items for your shop and kitchen.`).join("\n\n");
    const page = `Acme is a wholesaler.\n\n${filler}\n\nWe are hiring an accounts payable clerk to process supplier invoices in SAP Business One.\n\n${filler}`;
    const out = focusText(page, "accounts payable invoices ERP SAP hiring", 600);
    expect(out.length).toBeLessThan(800);
    expect(out).toContain("accounts payable clerk");
    expect(out.startsWith("Acme is a wholesaler.")).toBe(true);
    expect(out).toContain("[focused excerpt:");
    expect(focusText("short page", "anything", 600)).toBe("short page");
  });
});

describe("context + apply", () => {
  test("a footnote's quote must be on its saved page; plain-text web sources are refused", async () => {
    const ws = fixture();
    await persistCandidates(ws, ICP, "r", "t", [{ name: "Delta", domain: "delta.example", source_url: "https://delta.example" }]);
    writeRaw(ws, { provider: "firecrawl", op: "fetch_pages", url: "https://delta.example/about" }, "Delta supplies packaging to 400 bakeries in Belgium.");
    const up = (sources: unknown) => applyUpdates(ws, { icp: ICP, accounts: [{ domain: "delta.example", sections: { Snapshot: "Delta supplies packaging to bakeries in 18 countries.[^d1]" }, sources: sources as never }] });
    const added = await up({ d1: { label: "About", url: "https://delta.example/about", quote: "supplies packaging to bakeries in 18 countries" } });
    expect(added.results[0]!.errors.join()).toContain("not on the saved page");
    expect(readFileSync(join(ws, "accounts/delta.example/brief.md"), "utf8")).not.toContain("18 countries"); // nothing written
    expect((await up({ d1: "About, https://delta.example/about (2026-10-15)" })).results[0]!.errors.join()).toContain("needs {label, url, date, quote}");
    // a detail the quote doesn't carry is refused even when the quote itself is correct
    const extra = await up({ d1: { label: "About", url: "https://delta.example/about", date: "2026-10-15", quote: "supplies packaging to 400 bakeries in Belgium" } });
    expect(extra.results[0]!.errors.join()).toContain("has 18 but no quote");
    const ok = await applyUpdates(ws, { icp: ICP, accounts: [{ domain: "delta.example", sections: { Snapshot: "Delta supplies packaging to 400 bakeries in Belgium.[^d1]" }, sources: { d1: { label: "About", url: "https://delta.example/about", date: "2026-10-15", quote: "supplies packaging to 400 bakeries in Belgium" } } }] });
    expect(ok.results[0]!.ok).toBe(true);
    expect(readFileSync(join(ws, "accounts/delta.example/brief.md"), "utf8")).toContain("[^d1]: About, https://delta.example/about (2026-10-15) — “supplies packaging to 400 bakeries in Belgium”");
  });

  test("an invalid judgement is reported, not silently dropped (a missing factor would skew the score)", async () => {
    const ws = fixture();
    await persistCandidates(ws, ICP, "r", "t", [{ name: "Delta", domain: "delta.example", source_url: "https://delta.example" }]);
    const r = await applyUpdates(ws, { icp: ICP, accounts: [{ domain: "delta.example", mode: "light", judgements: [{ id: "industry_fit", level: 3, confidence: 0.9, evidence: [] }] }] });
    expect(r.results[0]!.ok).toBe(false);
    expect(r.results[0]!.errors.join()).toContain("judgement industry_fit: a factor with a level must cite evidence");
  });

  test("a footnote id still cited by a kept section can't be re-pointed at another source", () => {
    const brief = "## Snapshot\nDelta has 340 staff.[^b1]\n\n## Business & offering\nOld.[^b2]\n\n[^b1]: About, https://delta.example/about (2026-10-01) — “our 340 staff”\n[^b2]: News, https://n.example (2026-10-01) — “old”\n";
    const other = { b1: "Blog, https://delta.example/blog (2026-10-18) — “Bielen joins Delta”" };
    expect(footnoteClashes(brief, { "Business & offering": "New.[^b1]" }, other, false).join()).toContain("[^b1] already cites another source in Snapshot");
    expect(footnoteClashes(brief, { Snapshot: "Rewritten.[^b1]" }, other, false)).toEqual([]); // the section that used it is rewritten
    expect(footnoteClashes(brief, { "Business & offering": "New.[^c1]" }, { c1: other.b1 }, false)).toEqual([]); // a new id is fine
    expect(footnoteClashes(brief, {}, { b1: "About, https://delta.example/about (2026-10-01) — “our 340 staff”" }, false)).toEqual([]); // same definition
  });

  test("context is compact: auto factors flagged, light factors only", async () => {
    const ws = fixture();
    await persistCandidates(ws, ICP, "r", "t", [{ name: "Alpha", domain: "alpha.example", source_url: "https://alpha.example", employees: 320 }]);
    const ctx = await buildContext(ws, ICP, ["alpha.example", "missing.example"], "light");
    expect(ctx.factors.map((f) => f.id)).toEqual(["industry_fit", "ap_hiring"]);
    expect(ctx.auto_factors.map((f) => f.id)).toEqual(["company_size"]);
    expect(ctx.accounts[0]).toMatchObject({ domain: "alpha.example", stage: "discovered", facts: { employees: [320, 0.6, "https://alpha.example"] } });
    expect(ctx.accounts[1]).toMatchObject({ error: "no account file" });
    expect(JSON.stringify(ctx).length).toBeLessThan(6000);
  });

  test("light apply: facts + snapshot + judgements → light_scored in one call; rule factor auto-judged", async () => {
    const ws = fixture();
    await persistCandidates(ws, ICP, "r", "t", [{ name: "Alpha", domain: "alpha.example", source_url: "https://alpha.example" }, { name: "Beta", domain: "beta.example", source_url: "https://beta.example" }]);
    writeRaw(ws, { provider: "firecrawl", op: "fetch_pages", url: "https://alpha.example/about" }, "Alpha is a food wholesaler supplying restaurants, with about 320 staff.");
    const r = await applyUpdates(ws, {
      icp: ICP,
      accounts: [
        {
          domain: "alpha.example",
          facts: { employees: { value: 320, source_url: "https://alpha.example/about", confidence: 0.9 }, industry: { value: "food wholesale", source_url: "https://alpha.example/about", confidence: 0.9 } },
          sections: { Snapshot: "Alpha is a food wholesaler with about 320 staff.[^a1]" },
          sources: { a1: { label: "About page", url: "https://alpha.example/about", date: "2026-10-15", quote: "a food wholesaler supplying restaurants, with about 320 staff" } },
          judgements: [{ id: "industry_fit", level: 3, confidence: 0.9, evidence: [{ quote: "food wholesale", source_url: "https://alpha.example/about" }] }],
          mode: "light",
          changelog: "enrich-light: snapshot + light score",
        },
        // invalid: unsourced snapshot footnote → nothing written for beta
        { domain: "beta.example", sections: { Snapshot: "Beta claims.[^b1]" }, mode: "light" },
      ],
    });
    expect(r.applied).toBe(1);
    const a = r.results[0]!;
    expect(a).toMatchObject({ ok: true, stage: "light_scored" });
    expect(a.score!.coverage).toBeGreaterThan(0.5); // company_size came from the rule
    const score = readFileSync(join(ws, `accounts/alpha.example/scores/${ICP}.md`), "utf8");
    expect(score).toContain("rule: employees 320");
    const b = r.results[1]!;
    expect(b.ok).toBe(false);
    expect(b.errors.join()).toContain("[^b1] is used but never defined");
    expect((await readDoc<Company>(join(ws, "accounts/beta.example/company.md"))).data.icp_status[ICP]!.stage).toBe("discovered");
    const issues = (await lint(ws)).filter((i) => i.path.includes("alpha"));
    expect(issues).toEqual([]);
  });

  test("full apply: sections, people, signals, open questions, stage researched + full score → scored", async () => {
    const ws = fixture();
    await persistCandidates(ws, ICP, "r", "t", [{ name: "Gamma", domain: "gamma.example", source_url: "https://gamma.example", employees: 200 }]);
    // pretend light + shortlist already happened
    writeRaw(ws, { provider: "firecrawl", op: "fetch_pages", url: "https://gamma.example" }, "Gamma distributes car parts to independent garages.");
    writeRaw(ws, { provider: "firecrawl", op: "fetch_pages", url: "https://gamma.example/about" }, "We are a parts distributor for garages across Flanders.");
    writeRaw(ws, { provider: "exa", op: "search_news", url: "https://news.example/gamma-cfo" }, "Gamma appointed Jo Peeters as its new CFO on 1 August 2026.");
    await applyUpdates(ws, { icp: ICP, accounts: [{ domain: "gamma.example", sections: { Snapshot: "Gamma distributes parts.[^g0]" }, sources: { g0: { label: "Home", url: "https://gamma.example", date: "2026-10-15", quote: "Gamma distributes car parts to independent garages" } }, mode: "light", judgements: [] }] });
    const cp = join(ws, "accounts/gamma.example/company.md");
    writeFileSync(cp, readFileSync(cp, "utf8").replace("stage: light_scored", "stage: shortlisted\n    approved_by: hein"));
    const r = await applyUpdates(ws, {
      icp: ICP,
      accounts: [{
        domain: "gamma.example",
        sections: {
          "Business & offering": "Parts distributor for garages.[^g1]",
          "Situation & triggers": "- 2026-08-01 — appointed a new CFO.[^g2]",
          "People map": "- Finance leader: Jo Peeters, CFO.[^g2]",
          Technographics: "ERP not publicly identified after site and job-ad search.",
        },
        sources: {
          g1: { label: "About", url: "https://gamma.example/about", date: "2026-10-15", quote: "a parts distributor for garages" },
          g2: { label: "News", url: "https://news.example/gamma-cfo", date: "2026-08-01", quote: "appointed Jo Peeters as its new CFO on 1 August 2026" },
        },
        open_questions: ["- [x] New finance leadership? → yes, CFO since 2026-08.[^g2]", "- [ ] Which ERP? (unknown after research; owner: call-prep)"],
        people: [{ name: "Jo Peeters", title: "CFO", linkedin_url: "https://be.linkedin.com/in/jo-peeters-x", persona: "Finance leader", seniority: "c_level", source_url: "https://news.example/gamma-cfo", confidence: 0.9 }],
        signals: [{ type: "exec_change", title: "New CFO Jo Peeters", date: "2026-08-01", source_url: "https://news.example/gamma-cfo", confidence: 0.9, relevance: 3 }],
        stage: "researched",
        mode: "full",
        judgements: [{ id: "finance_change", level: 3, confidence: 0.9, evidence: [{ quote: "appointed a new CFO", source_url: "https://news.example/gamma-cfo" }] }],
        changelog: "research: business, triggers, people",
      }],
    });
    expect(r.results[0]).toMatchObject({ ok: true, stage: "scored" });
    expect(existsSync(join(ws, "people/jo-peeters-x.md"))).toBe(true);
    expect(existsSync(join(ws, "accounts/gamma.example/signals/2026-08-01-exec_change.md"))).toBe(true);
    const brief = readFileSync(join(ws, "accounts/gamma.example/brief.md"), "utf8");
    expect(brief).toContain("open_questions: 1");
    expect(brief).toContain("[^g2]: News, https://news.example/gamma-cfo");
    expect(brief).toContain("Gamma distributes parts.[^g0]"); // untouched section kept
    const off = await runOffline(ws);
    expect(off.results.filter((x) => x.target.includes("gamma") && x.key === "handoff_completeness")[0]!.score).toBe(1);
    expect((await lint(ws)).filter((i) => i.path.includes("gamma"))).toEqual([]);
  });

  test("rebuildBrief keeps order, merges footnotes, appends changelog", () => {
    const out = rebuildBrief("# X\n\n## Snapshot\nold[^1]\n\n## Changelog\n- a\n\n[^1]: https://x.example", { Snapshot: "new[^2]" }, { "2": "https://y.example" }, undefined, "did it");
    expect(out).toContain("## Snapshot\nnew[^2]");
    expect(out).toContain("[^1]: https://x.example");
    expect(out).toContain("[^2]: https://y.example");
    expect(out).toMatch(/- a\n- \d{4}-\d{2}-\d{2} did it/);
  });
});

test("fetch_pages with focus: model gets the relevant excerpt, the snapshot keeps the full page", async () => {
  const { callProvider } = await import("../../src/core/providers/gateway.ts");
  const { makeWorkspace } = await import("../helpers.ts");
  const ws = makeWorkspace();
  const long = ["Acme Foods is a Belgian wholesaler.", ...Array.from({ length: 60 }, (_, i) => `Product line ${i}: snacks, drinks and kitchen supplies for shops.`), "Vacancy: accounts payable clerk for supplier invoice processing in SAP."].join("\n\n");
  let requested = 0;
  const fc = { name: "firecrawl" as const, supports: ["fetch_pages"] as const, async run(_op: string, input: { urls: string[]; max_chars?: number }) {
    requested = input.max_chars ?? 0;
    return { results: [{ url: input.urls[0]!, title: "Careers", text: long }], cost_usd: 0.004, cost_kind: "actual" as const };
  } };
  const r = await callProvider("fetch_pages", { urls: ["https://acme.example/careers"], focus: "accounts payable invoices SAP hiring", max_chars: 800 }, { ws, adapters: { firecrawl: fc as never, exa: null }, mode: "live" });
  expect(requested).toBe(20_000);
  const page = r.results[0]! as unknown as { text: string; raw_ref: string };
  expect(page.text.length).toBeLessThan(1000);
  expect(page.text).toContain("accounts payable clerk");
  expect(readFileSync(join(ws, page.raw_ref), "utf8")).toContain("Product line 59");
});

test("signal-count rules: dated signals in the window set the level; no signals is 0 only after research", async () => {
  const { autoJudge } = await import("../../src/core/autojudge.ts");
  const { Factor } = await import("../../src/core/schemas.ts");
  const f = Factor.parse({
    id: "growth_move", name: "Growth move", group: "intent", weight: 3, question: "Expansion in the last 12 months?",
    levels: { 0: "none", 1: "older", 2: "one", 3: "two or more" },
    auto: { signals: { types: ["expansion", "mna"], within_days: 365 }, levels: { 0: "0", 2: "1", 3: ">=2" } },
  });
  const sig = (date: string, type: string, title: string) => ({ date, type, title, source_url: `https://news.example/${title}`, raw_ref: `raw/2026-10/${title}.md`, status: "new" }) as never;
  const today = "2026-10-15";
  const two = autoJudge(f, { facts: {} }, { today, researched: true, signals: [sig("2026-07-01", "mna", "acq"), sig("2026-03-01", "expansion", "store"), sig("2026-05-01", "hiring", "cfo")] });
  expect(two).toMatchObject({ level: 3, evidence: [{ quote: "2026-07-01: acq" }, { quote: "2026-03-01: store" }] });
  const old = autoJudge(f, { facts: {} }, { today, researched: true, signals: [sig("2025-01-01", "expansion", "old")] });
  expect(old).toMatchObject({ level: 0, evidence: [{ checked: true }] });
  expect(autoJudge(f, { facts: {} }, { today, researched: false, signals: [] })).toBeNull(); // nobody looked yet
  expect(() => Factor.parse({ ...f, auto: { fact: "employees", signals: { types: ["mna"], within_days: 30 }, levels: {} } })).toThrow();
});
