import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listDrafts, markDraft, markLearned, pendingEdits, snapshotOriginal } from "../../src/core/drafts.ts";
import { readDoc, stringifyDoc } from "../../src/core/frontmatter.ts";
import type { Adapter, AdapterResult, Op, OpInputs } from "../../src/core/providers/types.ts";
import type { Signal } from "../../src/core/schemas.ts";
import { validateContent } from "../../src/core/validate.ts";
import { addWatch, lineDiff, loadWatchlist, markStaleSignals, normalizePage, runSync } from "../../src/core/watch.ts";
import { dncMatcher } from "../../src/core/workspace.ts";
import { fact, makeWorkspace } from "../helpers.ts";

const D = "brightline-foods.example";
const company = stringifyDoc({ id: D, name: "Brightline Foods", facts: { employees: fact(320) }, icp_status: { mm: { stage: "scored", updated: "2026-10-15" } } });

/** Fake provider whose news results and page text can change between syncs. */
function fakeProviders(state: { news: { title: string; url: string; published: string }[]; page: string }) {
  const mk = (name: "exa" | "firecrawl", supports: Op[]): Adapter => ({
    name, supports,
    async run<O extends Op>(op: O, input: OpInputs[O]): Promise<AdapterResult<O>> {
      if (op === "search_news") return { results: state.news.map((n) => ({ ...n, summary: "s" })), cost_usd: 0.01, cost_kind: "actual" } as AdapterResult<O>;
      const urls = (input as OpInputs["fetch_pages"]).urls;
      return { results: urls.map((u) => ({ url: u, title: "Careers", text: state.page })), cost_usd: 0.004, cost_kind: "actual" } as AdapterResult<O>;
    },
  });
  return { adapters: { exa: mk("exa", ["search_news"]), firecrawl: mk("firecrawl", ["fetch_pages"]) }, mode: "live" as const };
}

describe("watch + sync", () => {
  test("first sync: news items + page baseline; second: only new news and the page diff", async () => {
    const ws = makeWorkspace({ [`accounts/${D}/company.md`]: company });
    await addWatch(ws, D, "mm", { pages: ["https://brightline-foods.example/careers"], by: "hein" });
    await expect(addWatch(ws, "nope.example", "mm")).rejects.toThrow(/does not exist/);
    const state = {
      news: [{ title: "Brightline opens Antwerp depot", url: "https://news.example/a", published: "2026-09-01" }],
      page: "Jobs\nWarehouse operator\nUpdated 01/09/2026",
    };
    const r1 = await runSync(ws, { gateway: fakeProviders(state) });
    expect(r1.items.map((i) => i.kind).sort()).toEqual(["news", "page_baseline"]);
    expect(r1.run_file).toMatch(/^sync\/.+\.md$/);
    expect(readFileSync(join(ws, r1.run_file!), "utf8")).toContain("decision: _pending_");
    const wl = loadWatchlist(ws).entries[0]!;
    expect(wl.last_news_check).toBeTruthy();
    expect(wl.seen).toHaveLength(1);

    // same news again + date-only page change → nothing new
    state.page = "Jobs\nWarehouse operator\nUpdated 15/10/2026";
    const r2 = await runSync(ws, { gateway: fakeProviders(state) });
    expect(r2.items).toEqual([]);
    expect(r2.run_file).toBeNull();

    // new article + a new AP job ad → news item + page diff with the added line
    state.news.push({ title: "Brightline appoints new CFO", url: "https://news.example/b", published: "2026-10-10" });
    state.page = "Jobs\nWarehouse operator\nAccounts Payable Clerk (m/f/x)\nUpdated 20/10/2026";
    const r3 = await runSync(ws, { gateway: fakeProviders(state) });
    expect(r3.items.map((i) => i.title)).toEqual(["Brightline appoints new CFO", "Changed: Careers"]);
    expect(r3.items[1]!.added).toEqual(["Accounts Payable Clerk (m/f/x)"]);
    expect(r3.cost_usd).toBeCloseTo(0.014);
  });

  test("normalizePage and lineDiff", () => {
    expect(normalizePage("  A  \n\n B 2026-10-15T10:00:00Z \n 03/04/2025 C")).toBe("A\nB\nC");
    expect(lineDiff("a\nb\nb", "b\nc")).toEqual({ added: ["c"], removed: ["a", "b"] });
  });

  test("expired signals are marked stale", async () => {
    const sig = (date: string) => stringifyDoc({ account: D, type: "funding", title: "t", date, source_url: "https://x.example", retrieved_at: date, confidence: 0.9, ttl_days: 90, status: "new" });
    const ws = makeWorkspace({ [`accounts/${D}/company.md`]: company, [`accounts/${D}/signals/old.md`]: sig("2025-01-01"), [`accounts/${D}/signals/new.md`]: sig(new Date().toISOString().slice(0, 10)) });
    expect(await markStaleSignals(ws)).toEqual([`accounts/${D}/signals/old.md`]);
    expect((await readDoc<Signal>(join(ws, `accounts/${D}/signals/old.md`))).data.status).toBe("stale");
  });
});

describe("drafts", () => {
  const draft = (over: Record<string, unknown> = {}, body = "Hi Jane,\n\nCongrats on the new depot.[^1] Worth a look?\n\n[^1]: https://news.example/a\n") =>
    stringifyDoc({ account: D, icp: "mm", person: "jane-doe", person_linkedin: "https://www.linkedin.com/in/jane-doe", channel: "email", step: 1, status: "draft", based_on: [`accounts/${D}/brief.md`], created: "2026-10-15", ...over }, body);

  test("validation: needs a cited fact, a basis, and a contactable recipient", () => {
    const rel = `accounts/${D}/drafts/2026-10-15-jane-doe-email.md`;
    expect(validateContent(rel, draft(), { privacyMode: true })).toEqual([]);
    expect(validateContent(rel, draft({}, "Hi Jane, want a demo?"), { privacyMode: true }).join()).toContain("cite at least one fact");
    expect(validateContent(rel, draft({ based_on: [] }), { privacyMode: true }).join()).toContain("based_on");
    const dnc = dncMatcher({ entries: [{ kind: "linkedin", value: "https://www.linkedin.com/in/jane-doe", reason: "opted_out" }] });
    expect(validateContent(rel, draft(), { privacyMode: true, dnc }).join()).toContain("do-not-contact");
    expect(validateContent(rel, draft({ channel: "intro_request" }, "Sam, could you introduce me to Jane?"), { privacyMode: true })).toEqual([]);
    expect(validateContent(`accounts/${D}/drafts/.originals/x.md`, "x", { privacyMode: true, exists: true }).join()).toContain("write-once");
  });

  test("snapshot → human edit → pending edit pair → learned", async () => {
    const rel = `accounts/${D}/drafts/2026-10-15-jane-doe-email.md`;
    const ws = makeWorkspace({ [`accounts/${D}/company.md`]: company, [rel]: draft() });
    expect(snapshotOriginal(ws, rel)).toEqual({ original: `accounts/${D}/drafts/.originals/2026-10-15-jane-doe-email.md`, created: true });
    expect(snapshotOriginal(ws, rel).created).toBe(false);
    expect(await pendingEdits(ws)).toEqual([]); // still a draft
    writeFileSync(join(ws, rel), draft({}, "Jane — congrats on the new depot.[^1] Open to a 10-min look?\n\n[^1]: https://news.example/a\n"));
    await markDraft(ws, rel, "sent");
    const pairs = await pendingEdits(ws);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.added).toContain("Jane — congrats on the new depot.[^1] Open to a 10-min look?");
    expect(pairs[0]!.unchanged).toBe(false);
    expect((await listDrafts(ws, { status: "sent" }))[0]).toMatchObject({ status: "sent", has_original: true, learned: false });
    await markLearned(ws, [rel]);
    expect(await pendingEdits(ws)).toEqual([]);
  });
});

describe("call prep validation", () => {
  test("requires frontmatter and sourced footnotes", () => {
    const rel = `accounts/${D}/callprep/2026-10-20.md`;
    const ok = stringifyDoc({ account: D, icp: "mm", meeting_date: "2026-10-20", attendees: [{ name: "Jane Doe", role: "CFO" }], created: "2026-10-15", sources_checked_at: "2026-10-15" }, "New CFO since March.[^1]\n\n[^1]: https://press.example/x\n");
    expect(validateContent(rel, ok, { privacyMode: true })).toEqual([]);
    expect(validateContent(rel, ok.replace("https://press.example/x", "a press release"), { privacyMode: true }).join()).toContain("no source");
  });
});
