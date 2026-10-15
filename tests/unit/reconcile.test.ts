import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDoc } from "../../src/core/frontmatter.ts";
import { reconcileAccount, type Ask } from "../../src/core/reconcile.ts";
import type { ScoreFile } from "../../src/core/schemas.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const D = "maasverhoeven.example";
const golden = () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-rc-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  return ws;
};
const stored = (ws: string) => parseDoc<ScoreFile>(readFileSync(join(ws, `accounts/${D}/scores/${ICP}.md`), "utf8")).data;
/** Scripted judges: 2nd opinion = stored levels with overrides; 3rd = given verdicts. */
function judges(ws: string, override: Record<string, number | null>, verdicts: unknown[] = []): Ask & { calls: number } {
  const levels = stored(ws).factors.map((f) => ({ id: f.id, level: f.id in override ? override[f.id] : f.level }));
  const ask = (async () => {
    ask.calls++;
    return { text: JSON.stringify(ask.calls === 1 ? levels : verdicts), cost_usd: 0.01 };
  }) as unknown as Ask & { calls: number };
  ask.calls = 0;
  return ask;
}

test("agreement changes nothing and costs one call", async () => {
  const ws = golden();
  const before = stored(ws);
  const ask = judges(ws, {});
  const r = await reconcileAccount(ws, ICP, D, { ask });
  expect(ask.calls).toBe(1);
  expect(r.changed).toEqual([]);
  expect(r.after).toBe(before.total);
});

test("a disagreement settled by a third judge with a real quote changes the level", async () => {
  const ws = golden();
  const ask = judges(ws, { finance_change: 2 }, [{ id: "finance_change", level: 2, quote: "acquired Delcourt Traiteur in Liège", source_url: "https://news.example/maas-verhoeven-acquires-delcourt", reason: "one dated move" }]);
  const r = await reconcileAccount(ws, ICP, D, { ask });
  expect(ask.calls).toBe(2);
  expect(r.changed).toEqual([{ id: "finance_change", from: 3, to: 2 }]);
  const f = stored(ws).factors.find((x) => x.id === "finance_change")!;
  expect(f).toMatchObject({ level: 2, evidence: [{ quote: "acquired Delcourt Traiteur in Liège" }] });
  expect(f.rationale).toContain("reconciled");
});

test("an unverifiable change is not applied: the original stands, marked disputed", async () => {
  const ws = golden();
  const ask = judges(ws, { finance_change: 1 }, [{ id: "finance_change", level: 1, quote: "a quote that is nowhere in the evidence", source_url: "https://news.example/x", reason: "?" }]);
  const r = await reconcileAccount(ws, ICP, D, { ask });
  expect(r.disputed).toEqual(["finance_change"]);
  const f = stored(ws).factors.find((x) => x.id === "finance_change")!;
  expect(f.level).toBe(3);
  expect(f.rationale).toContain("disputed");
});

test("the third judge siding with the first keeps the level", async () => {
  const ws = golden();
  const ask = judges(ws, { finance_change: 1 }, [{ id: "finance_change", level: 3, quote: null, source_url: null, reason: "two moves" }]);
  const r = await reconcileAccount(ws, ICP, D, { ask });
  expect(r.changed).toEqual([]);
  expect(stored(ws).factors.find((x) => x.id === "finance_change")!.level).toBe(3);
});

test("score/research batches get a second opinion when a judge is available", async () => {
  const ws = golden();
  const { runBatch } = await import("../../src/core/batch.ts");
  const ask = judges(ws, {});
  const r = await runBatch({ ws, skill: "score", icp: ICP, pluginRoot: PLUGIN_ROOT, domains: [D], runner: async () => ({ cost_usd: 0, ok: true, summary: "ok" }), ask, log: () => {} });
  expect(r.second_opinion).toEqual({ accounts: 1, changed: 0, disputed: 0 });
  const noJudge = await runBatch({ ws, skill: "score", icp: ICP, pluginRoot: PLUGIN_ROOT, domains: [D], runner: async () => ({ cost_usd: 0, ok: true, summary: "ok" }), log: () => {} });
  expect(noJudge.second_opinion).toBeNull(); // injected runner without a judge: never calls a real model
});
