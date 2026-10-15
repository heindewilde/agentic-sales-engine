import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { indexFile, openDb, reindexAll } from "../../src/core/db.ts";
import { stringifyDoc } from "../../src/core/frontmatter.ts";
import { estimateMcpCall, sumSpend, type LedgerEntry } from "../../src/core/ledger.ts";
import { fact, makeWorkspace } from "../helpers.ts";

const e = (o: Partial<LedgerEntry>): LedgerEntry => ({ ts: "2026-10-15T00:00:00Z", run_id: "r", provider: "exa", op: "search", usd: 0, kind: "est", ...o });

test("sumSpend counts each call once, actual overrides estimate", () => {
  expect(sumSpend([e({ usd: 0.1 }), e({ usd: 0.2 })])).toBe(0.3);
  expect(sumSpend([e({ call_id: "a", usd: 0.5 }), e({ call_id: "a", usd: 0.12, kind: "actual" })])).toBe(0.12);
});

test("estimateMcpCall is pessimistic for agents and scales with results", () => {
  expect(estimateMcpCall("mcp__x_exa__agent_run", { effort: "high" }).usd).toBe(0.5);
  expect(estimateMcpCall("mcp__x_exa__web_search_exa", { numResults: 100 }).usd).toBeCloseTo(0.097);
  expect(estimateMcpCall("mcp__other__thing", {}).usd).toBe(0);
});

test("reindex round-trip: files -> db, incremental update and delete", async () => {
  const ws = makeWorkspace({
    "accounts/acme.com/company.md": stringifyDoc({
      id: "acme.com", name: "Acme", facts: { hq_country: fact("BE"), employees: fact(120, { retrieved_at: "2020-01-01", ttl_days: 30 }) },
      icp_status: { mm: { stage: "light_scored", light_score: 64, updated: "2026-10-15" } },
    }),
    "people/jane-doe.md": stringifyDoc({ id: "jane-doe", name: "Jane Doe", company: "acme.com", facts: { title: fact("CFO") }, known_by: [{ member: "hein", connected_on: "2021-03-01" }] }),
  });
  expect((await reindexAll(ws)).files).toBe(2);
  const db = openDb(ws);
  expect(db.query("SELECT name, hq_country, employees FROM accounts").get()).toEqual({ name: "Acme", hq_country: "BE", employees: "120" });
  expect(db.query("SELECT stage, light_score FROM account_icp").get()).toEqual({ stage: "light_scored", light_score: 64 });
  expect((db.query("SELECT COUNT(*) n FROM facts WHERE expires_at < date('now')").get() as { n: number }).n).toBe(1);
  expect(db.query("SELECT member, company_domain FROM warm_paths").get()).toEqual({ member: "hein", company_domain: "acme.com" });
  expect((db.query("SELECT path FROM fts WHERE fts MATCH 'CFO'").all() as unknown[]).length).toBe(1);

  writeFileSync(join(ws, "accounts/acme.com/company.md"), stringifyDoc({ id: "acme.com", name: "Acme NV", facts: {}, icp_status: {} }));
  await indexFile(db, ws, join(ws, "accounts/acme.com/company.md"));
  expect(db.query("SELECT name FROM accounts").get()).toEqual({ name: "Acme NV" });
  expect((db.query("SELECT COUNT(*) n FROM account_icp").get() as { n: number }).n).toBe(0);

  rmSync(join(ws, "people/jane-doe.md"));
  await indexFile(db, ws, join(ws, "people/jane-doe.md"));
  expect((db.query("SELECT COUNT(*) n FROM people").get() as { n: number }).n).toBe(0);
  expect((db.query("SELECT COUNT(*) n FROM warm_paths").get() as { n: number }).n).toBe(0);
  db.close();
});
