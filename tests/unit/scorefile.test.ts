import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDoc, stringifyDoc } from "../../src/core/frontmatter.ts";
import type { Company } from "../../src/core/schemas.ts";
import { archiveScoring, loadKnownCustomers, rank, recomputeAll, runBacktest, runRecalibrate, runSensitivity, writeScore } from "../../src/core/scorefile.ts";
import { writeFileSync } from "node:fs";
import { lint } from "../../src/core/lint.ts";
import { fact, PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";

function fixtureCopy(): string {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-sc-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  return ws;
}

const ev = (domain: string, quote: string) => [{ quote, source_url: `https://${domain}/about` }];

/** Plausible judge output: good customers mostly 2–3, bad ones mostly 0–1, with some noise and unknowns. */
function judgementsFor(domain: string, label: "good" | "bad", i: number) {
  const hi = label === "good";
  const lv = (base: number) => Math.max(0, Math.min(3, base)) as 0 | 1 | 2 | 3;
  const mk = (id: string, level: number | null, conf = 0.8) =>
    level === null ? { id, level: null, confidence: 0, evidence: [] } : { id, level: lv(level), confidence: conf, evidence: ev(domain, `${id} evidence`), rationale: `${id} judged` };
  return [
    mk("company_size", hi ? 3 - (i % 2) : i % 3 === 0 ? 0 : 1),
    mk("industry_fit", hi ? 3 : i % 2),
    mk("erp_fit", hi ? 2 + (i % 2) : i % 3 === 1 ? 2 : null),
    mk("no_ap_tool", hi ? 2 : i === 8 ? 0 : 1),
    mk("finance_change", hi ? (i % 3) + 1 : i % 2),
    mk("ap_hiring", hi ? 2 : 0, 0.6),
    mk("warm_path", i % 4 === 0 ? 2 : null),
    mk("persona_reachable", hi ? 2 : 1),
  ];
}

describe("score files on the Ledgerly fixture", () => {
  test("calibration → backtest passes, sensitivity runs, files lint clean", async () => {
    const ws = fixtureCopy();
    const known = loadKnownCustomers(ws, ICP);
    expect(known).toHaveLength(20);
    for (const [i, k] of known.entries()) {
      await writeScore({ ws, icp: ICP, domain: k.domain, mode: "full", judgements: judgementsFor(k.domain, k.label, i), calibration: k.label });
    }
    // northwind-cargo.example is a DNC customer in the fixture, but calibration files are allowed.
    expect(existsSync(join(ws, `icps/${ICP}/calibration/brightline-foods.example.md`))).toBe(true);
    const bt = await runBacktest(ws, ICP);
    expect(bt.verdict).toBe("pass");
    expect(bt.auc!).toBeGreaterThanOrEqual(0.9);
    expect(bt.not_yet_judged).toEqual([]);
    const sens = await runSensitivity(ws, ICP);
    expect(sens.factors).toHaveLength(8);
    expect(await lint(ws)).toEqual([]);
  });

  test("light score advances stage, knockout excludes, rank orders and flags research-to-resolve", async () => {
    const ws = fixtureCopy();
    const company = (id: string, name: string) =>
      stringifyDoc({ id, name, facts: { industry: fact("wholesale", { source_url: `https://${id}` }) }, icp_status: { [ICP]: { stage: "discovered", updated: "2026-10-15" } } });
    for (const [id, name] of [["alpha.example", "Alpha"], ["beta.example", "Beta"], ["gamma.example", "Gamma"]] as const) {
      await Bun.write(join(ws, `accounts/${id}/company.md`), company(id, name));
    }
    const r1 = await writeScore({ ws, icp: ICP, domain: "alpha.example", mode: "light", judgements: [
      { id: "company_size", level: 3, confidence: 0.9, evidence: ev("alpha.example", "320 employees") },
      { id: "industry_fit", level: 3, confidence: 0.9, evidence: ev("alpha.example", "food wholesaler") },
      { id: "ap_hiring", level: 2, confidence: 0.6, evidence: ev("alpha.example", "hiring AP clerk") },
    ] });
    expect(r1).toMatchObject({ stage: "light_scored", tier: "A", coverage: 1 });
    const r2 = await writeScore({ ws, icp: ICP, domain: "beta.example", mode: "light", judgements: [
      { id: "company_size", level: 0, confidence: 0.9, evidence: ev("beta.example", "12 employees") },
    ] });
    expect(r2).toMatchObject({ stage: "excluded", tier: "X", knocked_out: ["company_size"] });
    const { data } = await readDoc<Company>(join(ws, "accounts/beta.example/company.md"));
    expect(data.icp_status[ICP]!.excluded_reason).toContain("company_size");
    // level without evidence becomes unknown instead of failing
    const r3 = await writeScore({ ws, icp: ICP, domain: "gamma.example", mode: "light", judgements: [{ id: "industry_fit", level: 3, confidence: 0.9, evidence: [] }] });
    expect(r3.coverage).toBe(0);
    expect(readFileSync(join(ws, "accounts/gamma.example/scores", `${ICP}.md`), "utf8")).toContain("no evidence → unknown");

    // the fixture also holds a fully researched golden account; this test is about the three new ones
    const ranked = (await rank(ws, ICP)).filter((r) => r.domain !== "maasverhoeven.example");
    expect(ranked.map((r) => r.domain)).toEqual(["alpha.example", "gamma.example", "beta.example"]);
    expect(ranked.find((r) => r.domain === "gamma.example")!.research_to_resolve).toBe(true);
    expect((await rank(ws, ICP, { stage: "light_scored" })).map((r) => r.domain)).toEqual(["alpha.example", "gamma.example"]);
    // Scoring alone doesn't satisfy the light_scored handoff contract: the brief Snapshot is still missing.
    const issues = await lint(ws);
    expect(issues.map((i) => `${i.kind} ${i.path}`).sort()).toEqual(["contract accounts/alpha.example", "contract accounts/gamma.example"]);
    expect(issues[0]!.detail).toContain("brief.md is missing");
  });

  test("rejects unknown factor ids and DNC accounts", async () => {
    const ws = fixtureCopy();
    await expect(writeScore({ ws, icp: ICP, domain: "x.example", mode: "full", judgements: [{ id: "nope", level: 1, confidence: 1, evidence: ev("x.example", "q") }] })).rejects.toThrow(/unknown factor ids/);
    await expect(writeScore({ ws, icp: ICP, domain: "northwind-cargo.example", mode: "full", judgements: [] })).rejects.toThrow(/do-not-contact/);
  });

  test("archive + weight edit + recompute re-scores from stored judgements", async () => {
    const ws = fixtureCopy();
    const known = loadKnownCustomers(ws, ICP);
    for (const [i, k] of known.entries()) await writeScore({ ws, icp: ICP, domain: k.domain, mode: "full", judgements: judgementsFor(k.domain, k.label, i), calibration: k.label });
    const before = readFileSync(join(ws, `icps/${ICP}/calibration/brightline-foods.example.md`), "utf8");
    const a = await archiveScoring(ws, ICP);
    expect(a).toMatchObject({ archived: `icps/${ICP}/scoring.history/v1.yaml`, next_version: 2 });
    const path = join(ws, `icps/${ICP}/scoring.yaml`);
    writeFileSync(path, readFileSync(path, "utf8").replace("version: 1", "version: 2").replace(/(id: warm_path[\s\S]*?weight: )2/, "$15"));
    const r = await recomputeAll(ws, ICP);
    expect(r.recomputed).toBe(21); // 20 calibration files + the golden account's score
    const after = readFileSync(join(ws, `icps/${ICP}/calibration/brightline-foods.example.md`), "utf8");
    expect(after).toContain("scoring_version: 2");
    expect(after).not.toBe(before);
  });

  test("recalibrate waits for enough outcomes", async () => {
    const ws = fixtureCopy();
    expect((await runRecalibrate(ws, ICP)).ready).toBe(false);
  });
});
