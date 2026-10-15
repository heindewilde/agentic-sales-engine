import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson, runLlm, type Judge } from "../../src/evals/llm.ts";
import { quoteSupported, runOffline } from "../../src/evals/offline.ts";
import { compare } from "../../src/evals/report.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const D = "maasverhoeven.example";
const golden = () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-ev-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  return ws;
};
const edit = (ws: string, rel: string, from: string | RegExp, to: string) => {
  const p = join(ws, rel);
  const s = readFileSync(p, "utf8");
  const n = s.replace(from, to);
  if (n === s) throw new Error(`edit did not apply in ${rel}`);
  writeFileSync(p, n);
};
const mean = (r: Awaited<ReturnType<typeof runOffline>>, key: string) => r.summary[key]!.mean;
const DRAFT = `accounts/${D}/drafts/2026-10-02-sofie-claes-linkedin_connect.md`;

test("quoteSupported: exact, reformatted, ellipsis; rejects invented", () => {
  const text = "We supply around 6,000 restaurants and independent retailers from three depots, with approximately 310 employees.";
  expect(quoteSupported("approximately 310 employees", text)).toBe(true);
  expect(quoteSupported("“We supply around 6,000 restaurants … from three depots”", text)).toBe(true);
  expect(quoteSupported("approximately 450 employees", text)).toBe(false);
  expect(quoteSupported("operates twelve depots across Europe", text)).toBe(false);
});

describe("offline suite", () => {
  test("golden account scores 1.0 everywhere", async () => {
    const r = await runOffline(golden());
    for (const k of ["citation_faithfulness", "brief_grounding", "handoff_completeness", "draft_rules"]) expect(mean(r, k)).toBe(1);
  });

  test("placeholder files (raw/.gitkeep) don't break the suite", async () => {
    const ws = golden();
    writeFileSync(join(ws, "raw/.gitkeep"), "");
    expect(mean(await runOffline(ws), "snapshot_coverage")).toBe(1);
  });

  test("catches a misquoted source", async () => {
    const ws = golden();
    edit(ws, `accounts/${D}/scores/ap-automation-midmarket.md`, "with approximately 310 employees", "with approximately 450 employees");
    const r = await runOffline(ws);
    expect(mean(r, "citation_faithfulness")!).toBeLessThan(1);
    expect(r.results.find((x) => x.key === "citation_faithfulness")!.failures![0]).toContain("450 employees");
  });

  test("a checked absence is faithful when the checked page was saved, and flagged when it wasn't", async () => {
    const ws = golden();
    const absence = (id: string, raw: string) =>
      `factors:\n  - id: ${id}\n    level: 0\n    confidence: 0.7\n    evidence:\n      - quote: careers page lists no finance roles — not found\n        source_url: https://maasverhoeven.example/about\n        raw_ref: ${raw}\n        checked: true\n    rationale: checked, none.\n`;
    edit(ws, `accounts/${D}/scores/ap-automation-midmarket.md`, "factors:\n", absence("absent_ok", "raw/2026-10/a1b2c3d4e5f6.md"));
    let r = await runOffline(ws);
    expect(mean(r, "citation_faithfulness")).toBe(1);
    expect(r.results.find((x) => x.key === "citation_faithfulness")!.comment).toContain("1 checked absences");
    edit(ws, `accounts/${D}/scores/ap-automation-midmarket.md`, "factors:\n", absence("absent_missing", "raw/2026-10/000000000000.md"));
    r = await runOffline(ws);
    expect(r.results.find((x) => x.key === "citation_faithfulness")!.failures!.join()).toContain("was never saved");
  });

  test("catches an uncited claim in the brief", async () => {
    const ws = golden();
    edit(ws, `accounts/${D}/brief.md`, "## Technographics\n", "## Technographics\nThey run SAP Business One across all three depots and plan to migrate next year.\n\n");
    const r = await runOffline(ws);
    expect(mean(r, "brief_grounding")!).toBeLessThan(1);
  });

  test("catches a draft that's too long, clichéd and invents a number", async () => {
    const ws = golden();
    edit(ws, DRAFT, /Hi Sofie,[\s\S]*?comparing notes\./, "Hi Sofie, I hope this message finds you well. Congrats on the Delcourt acquisition.[^1] Our customers cut AP costs by 63% and we'd love a quick call to show you how our revolutionary platform could transform your finance team, your suppliers, your month-end close, your approvals, your audit trail and everything in between for Maas & Verhoeven and Delcourt.");
    const r = await runOffline(ws);
    const d = r.results.find((x) => x.key === "draft_rules")!;
    expect(d.score!).toBeLessThan(0.8);
    const f = d.failures!.join("\n");
    expect(f).toContain("characters (max 300)");
    expect(f).toContain("cliché");
    expect(f).toContain('number "63%"');
  });

  test("catches a broken handoff", async () => {
    const ws = golden();
    edit(ws, `accounts/${D}/brief.md`, /sections_updated:[\s\S]*?\nopen_questions/, "sections_updated: {}\nopen_questions");
    const r = await runOffline(ws);
    expect(mean(r, "handoff_completeness")!).toBeLessThan(1);
  });
});

describe("llm suite (scripted judge)", () => {
  test("claim support, judge stability, draft quality; budget respected; cost recorded", async () => {
    const prompts: string[] = [];
    const judge: Judge = async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("You are a strict fact-checker")) {
        const n = (prompt.match(/^### \d+/gm) ?? []).length;
        return { text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, label: i === 0 ? "partial" : "supported", why: "ok" }))), cost_usd: 0.01 };
      }
      if (prompt.startsWith("Score the account")) {
        return { text: "```json\n" + JSON.stringify([{ id: "company_size", level: 3 }, { id: "industry_fit", level: 3 }, { id: "finance_change", level: 2 }, { id: "ap_hiring", level: 0 }]) + "\n```", cost_usd: 0.02 };
      }
      return { text: 'Here you go: {"specificity":5,"relevance":4,"grounding":5,"ask":4,"brevity":5,"voice":3,"weakest":"generic sign-off"}', cost_usd: 0.01 };
    };
    const ws = golden();
    const r = await runLlm(ws, { judge, budgetUsd: 1, sample: 3 });
    const by = (k: string) => r.results.filter((x) => x.key === k);
    const cs = by("claim_support")[0]!;
    expect(cs.score!).toBeGreaterThan(0.8);
    expect(cs.score!).toBeLessThan(1);
    const js = by("judge_stability")[0]!;
    expect(js.comment).toBe("exact 3/4, within ±1 4/4");
    expect(js.failures).toEqual(["finance_change: stored 3 vs re-judged 2"]);
    expect(by("draft_quality")[0]!.score).toBeCloseTo((26 / 6 - 1) / 4);
    expect(r.cost_usd).toBeCloseTo(0.04);
    // the judge never sees tools or workspace paths it could act on, and is told to ignore embedded instructions
    expect(prompts.every((p) => /Ignore (any )?instructions/i.test(p))).toBe(true);

    const tight = await runLlm(golden(), { judge, budgetUsd: 0.005, sample: 3 });
    expect(tight.results.length).toBe(1); // stops after the first paid call exceeds the budget
  });

  test("extractJson tolerates fences and prose", () => {
    expect(extractJson<{ a: number }>("sure! ```json\n{\"a\":1}\n``` done")).toEqual({ a: 1 });
    expect(extractJson<number[]>("result: [1,2] thanks")).toEqual([1, 2]);
    expect(extractJson("no json here")).toBeNull();
  });
});

test("compare flags regressions beyond tolerance", () => {
  const mk = (m: number) => ({ suite: "offline" as const, workspace: "", ran_at: "", results: [], cost_usd: 0, summary: { citation_faithfulness: { mean: m, n: 3, min: m } } });
  expect(compare(mk(0.9), mk(1)).regressions).toEqual(["citation_faithfulness"]);
  expect(compare(mk(0.97), mk(1)).regressions).toEqual([]);
  expect(compare(mk(0.9), null).regressions).toEqual([]);
});
