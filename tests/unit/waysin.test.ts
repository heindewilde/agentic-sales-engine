import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefSkeleton, persistCandidates } from "../../src/core/accounts.ts";
import { reindexAll } from "../../src/core/db.ts";
import { readDoc, stringifyDoc, stringifyYaml } from "../../src/core/frontmatter.ts";
import type { Company } from "../../src/core/schemas.ts";
import { advanceStage, personaFor, staleFacts, waysIn } from "../../src/core/waysin.ts";
import { fact, PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const D = "brightline-foods.example";
const fixture = () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-wi-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  return ws;
};

async function account(ws: string, stage: string) {
  await persistCandidates(ws, ICP, "r", "test", [{ name: "Brightline Foods", domain: D, source_url: `https://${D}`, employees: 320 }]);
  const p = join(ws, `accounts/${D}/company.md`);
  const { data, body } = await readDoc<Company>(p);
  data.icp_status[ICP] = { ...data.icp_status[ICP]!, stage: stage as never, approved_by: "hein" };
  writeFileSync(p, stringifyDoc(data, body));
}

describe("advanceStage", () => {
  test("refuses until the contract holds, then advances; never backwards", async () => {
    const ws = fixture();
    await account(ws, "shortlisted");
    const r1 = await advanceStage(ws, D, ICP, "researched");
    expect(r1.advanced).toBe(false);
    expect(r1.errors.join("\n")).toContain('[light_scored] brief section "Snapshot" has not been written');
    expect(r1.errors.join("\n")).toContain('[researched] brief section "People map" has not been written');
    // write the brief sections the contracts need + a light score
    const brief = join(ws, `accounts/${D}/brief.md`);
    const { data, body } = await readDoc<Record<string, unknown>>(brief);
    data.sections_updated = { Snapshot: "2026-10-15", "Business & offering": "2026-10-15", "Situation & triggers": "2026-10-15", "People map": "2026-10-15", "Open questions": "2026-10-15" };
    writeFileSync(brief, stringifyDoc(data, body));
    const { writeScore } = await import("../../src/core/scorefile.ts");
    await writeScore({ ws, icp: ICP, domain: D, mode: "light", judgements: [] });
    const r2 = await advanceStage(ws, D, ICP, "researched");
    expect(r2).toMatchObject({ advanced: true, stage: "researched" });
    await expect(advanceStage(ws, D, ICP, "shortlisted")).rejects.toThrow(/back to/);
    expect((await advanceStage(ws, D, ICP, "excluded", "acquired by a competitor")).stage).toBe("excluded");
  });
});

describe("ways in", () => {
  test("personaFor matches ICP persona titles", () => {
    const icp = { personas: [{ name: "Finance leader", titles: ["CFO", "Finance Director"], jobs: [], pains: [], gains: [] }, { name: "AP lead", titles: ["AP Manager", "Head of Accounts Payable"], jobs: [], pains: [], gains: [] }] };
    expect(personaFor("Group CFO", icp)).toBe("Finance leader");
    expect(personaFor("head of accounts payable", icp)).toBe("AP lead");
    expect(personaFor("Marketing Manager", icp)).toBeNull();
  });

  test("ranks warm paths, lists recent signals and personas still unnamed", async () => {
    const ws = fixture();
    await account(ws, "scored");
    const wm = (member: string, matches: object[]) => {
      mkdirSync(join(ws, "team", member), { recursive: true });
      writeFileSync(join(ws, "team", member, "warm-matches.yaml"), stringifyYaml({ member, matches }));
    };
    wm("hein", [{ person_id: "pat-sales", name: "Pat Sales", linkedin_url: null, position: "Sales Director", company_name: "Brightline Foods", account: D, connected_on: "2019-01-01", quality: "exact" }]);
    wm("sam", [{ person_id: "marie-peeters", name: "Marie Peeters", linkedin_url: "https://www.linkedin.com/in/marie-peeters", position: "CFO", company_name: "Brightline Foods NV", account: D, connected_on: "2021-03-15", quality: "exact" }]);
    const sig = (date: string, title: string, rel: number) =>
      stringifyDoc({ account: D, type: "exec_change", title, date, source_url: "https://press.example/x", retrieved_at: "2026-10-15", confidence: 0.9, relevance: { [ICP]: rel }, ttl_days: 365, status: "new" });
    mkdirSync(join(ws, `accounts/${D}/signals`), { recursive: true });
    mkdirSync(join(ws, "people"), { recursive: true });
    writeFileSync(join(ws, `accounts/${D}/signals/2026-03-01-exec_change.md`), sig("2026-03-01", "New CFO", 3));
    writeFileSync(join(ws, `accounts/${D}/signals/2024-01-01-exec_change.md`), sig("2024-01-01", "Old news", 3));
    writeFileSync(join(ws, "people/marie-peeters.md"), stringifyDoc({ id: "marie-peeters", name: "Marie Peeters", company: D, facts: { title: fact("CFO") } }));

    const r = await waysIn(ws, D, ICP);
    expect(r.warm_paths.map((w) => [w.member, w.strength, w.persona])).toEqual([["sam", 3, "Finance leader"], ["hein", 2, null]]);
    expect(r.suggested_warm_path_level).toBe(3);
    expect(r.signals.map((s) => s.title)).toEqual(["New CFO"]);
    expect(r.people).toEqual([{ id: "marie-peeters", name: "Marie Peeters", title: "CFO", persona: "Finance leader", known_by: [] }]);
    expect(r.personas_without_named_person).toEqual(["AP lead"]);
  });
});

describe("staleFacts", () => {
  test("lists expired facts, most advanced accounts first", async () => {
    const ws = fixture();
    const mk = (d: string, stage: string) =>
      Bun.write(join(ws, `accounts/${d}/company.md`), stringifyDoc({ id: d, name: d, facts: { employees: fact(100, { retrieved_at: "2024-01-01", ttl_days: 30 }), hq_country: fact("BE") }, icp_status: { [ICP]: { stage, updated: "2026-10-15" } } }));
    await mk("early.example", "discovered");
    await mk("late.example", "scored");
    await Bun.write(join(ws, "accounts/late.example/brief.md"), briefSkeleton("late.example", "late", "x"));
    await reindexAll(ws);
    const r = await staleFacts(ws, { icp: ICP });
    expect(r.items.map((i) => i.entity)).toEqual(["company:late.example", "company:early.example"]);
    expect(r.items[0]!.facts.map((f) => f.field)).toEqual(["employees"]);
  });
});
