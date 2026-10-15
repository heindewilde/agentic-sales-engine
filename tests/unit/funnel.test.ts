import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistCandidates } from "../../src/core/accounts.ts";
import { runBatch, accountsAtStage } from "../../src/core/batch.ts";
import { openDb, reindexAll } from "../../src/core/db.ts";
import { readDoc } from "../../src/core/frontmatter.ts";
import { companyKey, importConnections, parseConnectedOn, parseConnections, readSeedCsv, readWarmMatches, rematchAll } from "../../src/core/importers.ts";
import { readLedger } from "../../src/core/ledger.ts";
import { lint } from "../../src/core/lint.ts";
import type { Company } from "../../src/core/schemas.ts";
import { writeScore } from "../../src/core/scorefile.ts";
import { approveShortlist, proposeShortlist, tickedDomains } from "../../src/core/shortlist.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const fixture = () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-fn-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  return ws;
};
const company = async (ws: string, d: string) => (await readDoc<Company>(join(ws, "accounts", d, "company.md"))).data;

const SEEDS = `Company Name;Website;Country;# Employees;Industry
Brightline Foods;https://www.brightline-foods.example;Belgium;320;Food wholesale
Northwind Cargo;northwind-cargo.example;Netherlands;210;Logistics
Ostara Parts;ostara-parts.example;Germany;600;Automotive parts
Ostara Parts GmbH;www.ostara-parts.example/de;Germany;600;Automotive parts
No Website BV;;Belgium;50;Retail
`;

const CONNECTIONS = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Marie,Peeters,https://www.linkedin.com/in/marie-peeters-1,marie@gmail.com,Brightline Foods NV,CFO,15 Mar 2021
Tom,Jansen,https://www.linkedin.com/in/tom-jansen,,Ostara Parts,Head of AP,02 Jan 2024
Ann,Other,https://www.linkedin.com/in/ann-other,,Unrelated Corp,CEO,01 Feb 2020
`;

describe("seed import", () => {
  test("detects columns (semicolon CSV), dedupes, skips DNC and rows without domain", async () => {
    const ws = fixture();
    const file = join(ws, "imports/seeds/fair.csv");
    writeFileSync(file, SEEDS);
    const { candidates, columns, rows } = readSeedCsv(ws, file);
    expect(rows).toBe(5);
    expect(columns).toMatchObject({ name: "Company Name", domain: "Website", hq_country: "Country", employees: "# Employees", industry: "Industry" });
    const res = await persistCandidates(ws, ICP, "2026-10-15-import", "import:imports/seeds/fair.csv", candidates);
    expect(res.created.sort()).toEqual(["brightline-foods.example", "ostara-parts.example"]);
    expect(res.skipped_dnc).toEqual(["northwind-cargo.example"]);
    expect(res.skipped_no_domain).toEqual(["No Website BV"]);
    const c = await company(ws, "brightline-foods.example");
    expect(c.facts.employees).toMatchObject({ value: 320, source_url: "import:imports/seeds/fair.csv", confidence: 0.5, method: "import" });
    expect(c.icp_status[ICP]!.stage).toBe("discovered");
    expect(existsSync(join(ws, "accounts/brightline-foods.example/brief.md"))).toBe(true);
    expect(readFileSync(join(ws, `lists/${ICP}/2026-10-15-import/candidates.csv`), "utf8")).toContain("northwind-cargo.example");
    // second import of the same list: nothing new, nothing overwritten
    const again = await persistCandidates(ws, ICP, "2026-10-16-import", "import:imports/seeds/fair.csv", candidates);
    expect(again.created).toEqual([]);
    expect(again.already_in_icp.sort()).toEqual(["brightline-foods.example", "ostara-parts.example"]);
    // the same company for another ICP gets the new ICP added
    const other = await persistCandidates(ws, "other-icp", "r1", "x", candidates.slice(0, 1));
    expect(other.added_to_icp).toEqual(["brightline-foods.example"]);
    expect(Object.keys((await company(ws, "brightline-foods.example")).icp_status).sort()).toEqual([ICP, "other-icp"]);
    expect((await lint(ws)).filter((i) => i.kind === "invalid")).toEqual([]);
  });
});

describe("connections", () => {
  test("parses LinkedIn export with preamble, drops emails, parses dates", () => {
    const c = parseConnections(CONNECTIONS);
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({ first_name: "Marie", last_name: "Peeters", linkedin_url: "https://www.linkedin.com/in/marie-peeters-1", company: "Brightline Foods NV", position: "CFO", connected_on: "2021-03-15" });
    expect(JSON.stringify(c)).not.toContain("gmail");
    expect(parseConnectedOn("2 Jan 2024")).toBe("2024-01-02");
    expect(() => parseConnections("a,b\n1,2")).toThrow(/Connections.csv/);
  });
  test("companyKey strips legal forms", () => {
    expect(companyKey("Brightline Foods NV")).toBe("brightline foods");
    expect(companyKey("Kessler Armaturen GmbH & Co. KG")).toBe("kessler armaturen kg");
  });
  test("import matches tracked accounts only, keeps raw export local, indexes warm paths", async () => {
    const ws = fixture();
    const file = join(ws, "imports/seeds/fair.csv");
    writeFileSync(file, SEEDS);
    await persistCandidates(ws, ICP, "r", "import:imports/seeds/fair.csv", readSeedCsv(ws, file).candidates);
    const src = join(mkdtempSync(join(tmpdir(), "li-")), "Connections.csv");
    writeFileSync(src, CONNECTIONS);
    const r = await importConnections(ws, "hein", src);
    expect(r).toMatchObject({ member: "hein", connections: 3, matches: 2, accounts: 2 });
    expect(existsSync(join(ws, "team/hein/connections.csv"))).toBe(true);
    const wm = readFileSync(join(ws, "team/hein/warm-matches.yaml"), "utf8");
    expect(wm).toContain("marie-peeters-1");
    expect(wm).not.toContain("Unrelated Corp");
    expect(wm).not.toContain("gmail");
    const matches = readWarmMatches(ws);
    expect(matches.find((m) => m.name === "Tom Jansen")).toMatchObject({ account: "ostara-parts.example", quality: "exact", member: "hein" });
    await reindexAll(ws);
    const db = openDb(ws);
    expect((db.query("SELECT COUNT(*) n FROM warm_paths WHERE member = 'hein'").get() as { n: number }).n).toBe(2);
    db.close();
    // new account appears later → rematch picks it up
    await persistCandidates(ws, ICP, "r2", "https://x.example", [{ name: "Unrelated Corp", domain: "unrelated.example", source_url: "https://unrelated.example" }]);
    expect((await rematchAll(ws)).hein).toEqual({ matches: 3, accounts: 3 });
  });
});

/** Light-score fixture accounts with a fake judge so the shortlist has a pool. */
async function lightScoredPool(ws: string, n: number) {
  const cands = Array.from({ length: n }, (_, i) => ({ name: `Prospect ${i}`, domain: `prospect-${i}.example`, source_url: `https://prospect-${i}.example` }));
  await persistCandidates(ws, ICP, "r", "test", cands);
  for (let i = 0; i < n; i++) {
    const d = `prospect-${i}.example`;
    const lvl = (x: number) => Math.max(0, Math.min(3, x)) as 0 | 1 | 2 | 3;
    const ev = [{ quote: "q", source_url: `https://${d}` }];
    const judged = i === n - 1
      ? [{ id: "company_size", level: 0 as const, confidence: 0.9, evidence: ev }] // knocked out
      : i === n - 2
        ? [] // nothing known: low score, high upside
        : [
            { id: "company_size", level: lvl(3 - (i % 3)), confidence: 0.9, evidence: ev },
            { id: "industry_fit", level: lvl(3 - (i % 3)), confidence: 0.8, evidence: ev },
            { id: "ap_hiring", level: lvl(i % 2 ? 1 : 2), confidence: 0.6, evidence: ev },
          ];
    await writeScore({ ws, icp: ICP, domain: d, mode: "light", judgements: judged });
  }
}

describe("shortlist (GATE 2)", () => {
  test("proposes top % + research-to-resolve, excludes knockouts, estimates cost", async () => {
    const ws = fixture();
    await lightScoredPool(ws, 20);
    const p = await proposeShortlist(ws, ICP, { pct: 15 });
    expect(p.pool).toBe(19); // knocked-out account is excluded, not light_scored
    expect(p.picked.length).toBeGreaterThanOrEqual(3);
    expect(p.picked.some((x) => x.why.startsWith("research to resolve"))).toBe(true);
    expect(p.picked.some((x) => x.domain === "prospect-19.example")).toBe(false);
    expect(p.cost.total_p90).toBeCloseTo(p.picked.length * 1.0); // fixture: $0.50/account p50 → $1.00 p90
    const text = readFileSync(join(ws, p.path), "utf8");
    expect(tickedDomains(text)).toEqual(p.picked.map((x) => x.domain));
  });
  test("approval needs a real member, respects unticked rows, moves stage", async () => {
    const ws = fixture();
    await lightScoredPool(ws, 10);
    const p = await proposeShortlist(ws, ICP, { pct: 30 });
    const file = join(ws, p.path);
    const [first, second] = p.picked;
    writeFileSync(file, readFileSync(file, "utf8").replace(`| [x] | ${second!.domain} |`, `| [ ] | ${second!.domain} |`));
    await expect(approveShortlist(ws, ICP, p.path, "mallory")).rejects.toThrow(/not a member/);
    const r = await approveShortlist(ws, ICP, p.path, "hein");
    expect(r.approved).toContain(first!.domain);
    expect(r.approved).not.toContain(second!.domain);
    const c = await company(ws, first!.domain);
    expect(c.icp_status[ICP]).toMatchObject({ stage: "shortlisted", approved_by: "hein" });
    expect(r.suggested_budget_usd).toBeCloseTo(r.approved.length * 1.0);
    // shortlisted contract (approved_by) holds; light_scored contract still needs the Snapshot from enrich-light
    const issues = (await lint(ws)).filter((i) => i.kind === "contract" && i.path === `accounts/${first!.domain}`);
    expect(issues.every((i) => i.detail.includes("[light_scored]"))).toBe(true);
  });
});

describe("batch driver", () => {
  test("chunks accounts, records model cost, stops at budget, resumes by stage", async () => {
    const ws = fixture();
    await persistCandidates(ws, ICP, "r", "test", Array.from({ length: 7 }, (_, i) => ({ name: `P${i}`, domain: `p${i}.example`, source_url: `https://p${i}.example` })));
    const prompts: string[] = [];
    // Fake session: light-scores every domain in the prompt.
    const runner = async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      for (const d of prompt.split("\n")[0]!.match(/[a-z0-9-]+\.example/g) ?? []) {
        await writeScore({ ws, icp: ICP, domain: d, mode: "light", judgements: [{ id: "industry_fit", level: 2, confidence: 0.8, evidence: [{ quote: "q", source_url: `https://${d}` }] }] });
      }
      return { cost_usd: 0.3, ok: true, summary: "done" };
    };
    const dry = await runBatch({ ws, skill: "enrich-light", icp: ICP, pluginRoot: PLUGIN_ROOT, chunk: 3, dryRun: true });
    expect(dry).toMatchObject({ accounts: 7, chunks: 3, dry_run: true, model: "haiku" });

    const r = await runBatch({ ws, skill: "enrich-light", icp: ICP, pluginRoot: PLUGIN_ROOT, chunk: 3, concurrency: 1, budgetUsd: 0.5, runner, log: () => {} });
    // budget 0.5, $0.30 per chunk → second chunk runs (0.2 left > 0.01), third is stopped
    expect(r.stopped).toContain("budget exhausted");
    expect(r.processed).toBe(6);
    expect(r.advanced).toBe(6);
    expect(prompts[0]!.split("\n")[0]).toBe(`/agentic-sales-engine:enrich-light --icp ${ICP} --unattended p0.example p1.example p2.example`);
    expect(prompts[0]).toContain("Unattended batch session");
    expect(readLedger(ws).filter((e) => e.provider === "anthropic")).toHaveLength(2);
    expect(await accountsAtStage(ws, ICP, "discovered")).toEqual(["p6.example"]);
    expect(existsSync(join(ws, r.log!))).toBe(true);
  });
});
