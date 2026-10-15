import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { persistCandidates } from "../../src/core/accounts.ts";
import { stringifyDoc } from "../../src/core/frontmatter.ts";
import { latestOutcomes, outcomeStats, readOutcomes, winLossCases } from "../../src/core/outcomes.ts";
import { archiveScoring, loadScoring, recomputeAll, runRecalibrate, writeScore } from "../../src/core/scorefile.ts";
import { auc, wilson } from "../../src/core/stats.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const ase = (ws: string, args: string[]) =>
  Bun.spawnSync(["bun", join(PLUGIN_ROOT, "src/cli/ase.ts"), ...args, "--workspace", ws], { env: { ...process.env, CLAUDE_PROJECT_DIR: "", ASE_WORKSPACE: "" } });

test("wilson interval matches reference values", () => {
  expect(wilson(2, 3)).toEqual({ rate: 0.667, low: 0.208, high: 0.939 });
  expect(wilson(0, 10).high).toBeCloseTo(0.278, 3);
  expect(wilson(0, 0).rate).toBeNull();
});

test("latest outcome per account: a later no_response never hides engagement", () => {
  const rows = [
    { date: "2026-01-01", account: "a.example", icp: ICP, member: "hein", outcome: "meeting" as const, note: "" },
    { date: "2026-02-01", account: "a.example", icp: ICP, member: "hein", outcome: "no_response" as const, note: "" },
    { date: "2026-01-01", account: "b.example", icp: ICP, member: "hein", outcome: "no_response" as const, note: "" },
    { date: "2026-03-01", account: "b.example", icp: ICP, member: "hein", outcome: "lost" as const, note: "chose competitor" },
  ];
  const m = latestOutcomes(rows);
  expect(m.get(`a.example|${ICP}`)).toMatchObject({ outcome: "meeting", history: ["meeting", "no_response"] });
  expect(m.get(`b.example|${ICP}`)!.outcome).toBe("lost");
});

/**
 * Simulated learning loop. Ground truth: accounts engage when finance_change is high (a new CFO / ERP change),
 * regardless of industry_fit — but the v1 model weights industry_fit (3) and finance_change (3) equally and
 * company size heavily, so it mis-ranks some accounts. Recalibration should notice and propose the fix.
 */
describe("outcome learning loop (simulated)", () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-oc-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  const N = 40;
  const lv = (x: number) => Math.max(0, Math.min(3, x)) as 0 | 1 | 2 | 3;
  // deterministic pseudo-random so the test is stable
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const truth: Record<string, { finance: number; engaged: boolean }> = {};

  test("set up 40 full-scored accounts with outcomes logged via the CLI", async () => {
    const domains = Array.from({ length: N }, (_, i) => `acct-${i}.example`);
    await persistCandidates(ws, ICP, "sim", "sim", domains.map((d) => ({ name: d, domain: d, source_url: `https://${d}` })));
    for (const [i, d] of domains.entries()) {
      const finance = Math.floor(rnd() * 4);
      const industry = Math.floor(rnd() * 4);
      const ev = [{ quote: "q", source_url: `https://${d}` }];
      const judged = [
        { id: "company_size", level: lv(2 + Math.floor(rnd() * 2)), confidence: 0.9, evidence: ev },
        { id: "industry_fit", level: lv(industry), confidence: 0.9, evidence: ev },
        { id: "erp_fit", level: lv(Math.floor(rnd() * 4)), confidence: 0.7, evidence: ev },
        { id: "no_ap_tool", level: lv(1 + Math.floor(rnd() * 3)), confidence: 0.7, evidence: ev },
        { id: "finance_change", level: lv(finance), confidence: 0.9, evidence: ev },
        { id: "ap_hiring", level: lv(Math.floor(rnd() * 4)), confidence: 0.6, evidence: ev },
        { id: "warm_path", level: lv(Math.floor(rnd() * 2)), confidence: 0.8, evidence: ev },
        { id: "persona_reachable", level: lv(1 + Math.floor(rnd() * 2)), confidence: 0.8, evidence: ev },
      ];
      await writeScore({ ws, icp: ICP, domain: d, mode: "full", judgements: judged });
      // engagement driven by finance change, with a little noise
      const engaged = finance >= 2 ? rnd() < 0.85 : rnd() < 0.1;
      truth[d] = { finance, engaged };
      const outcome = engaged ? (i % 5 === 0 ? "won" : "meeting") : i % 3 === 0 ? "lost" : "no_response";
      if (finance >= 2) {
        mkdirSync(join(ws, `accounts/${d}/signals`), { recursive: true });
        writeFileSync(join(ws, `accounts/${d}/signals/2026-06-01-exec_change.md`), stringifyDoc({ account: d, type: "exec_change", title: "New CFO", date: "2026-06-01", source_url: `https://news.example/${d}`, retrieved_at: "2026-10-15", confidence: 0.9, relevance: { [ICP]: 3 }, ttl_days: 180 }));
      }
      const r = ase(ws, ["outcome", "log", d, outcome, "--icp", ICP, "--member", "hein", "--note", engaged ? "replied to CFO-change angle" : "no interest"]);
      expect(r.exitCode).toBe(0);
    }
    expect(readOutcomes(ws, ICP)).toHaveLength(N);
  });

  test("stats: counts, intervals, readiness", async () => {
    const s = await outcomeStats(ws, ICP);
    expect(s.accounts_with_outcome).toBe(N);
    const engaged = Object.values(truth).filter((t) => t.engaged).length;
    expect(s.overall.engaged).toBe(engaged);
    expect(s.overall.low).toBeLessThan(s.overall.rate!);
    expect(s.recalibration.ready).toBe(true);
    expect(Object.keys(s.by_tier).length).toBeGreaterThan(0);
    expect(s.median_score.engaged).not.toBeNull();
    // the exec_change trigger engages far more often than accounts without a trigger
    expect(s.by_trigger.exec_change!.rate!).toBeGreaterThan(s.by_trigger["(none)"]!.rate! + 0.4);
  });

  test("recalibration finds the real driver; applying it improves ranking", async () => {
    const before = await loadScoring(ws, ICP);
    const engagedOf = (d: string) => truth[d]!.engaged;
    const totals = async () => {
      const out: number[] = [];
      const labels: boolean[] = [];
      for (const d of Object.keys(truth)) {
        const t = readFileSync(join(ws, `accounts/${d}/scores/${ICP}.md`), "utf8");
        out.push(Number(/^total: ([\d.]+)$/m.exec(t)![1]));
        labels.push(engagedOf(d));
      }
      return auc(out, labels)!;
    };
    const aucBefore = await totals();

    const rec = await runRecalibrate(ws, ICP);
    expect(rec.ready).toBe(true);
    const proposal = (rec as { proposal: { factors: { factor: string; proposed_weight: number; coefficient: number }[]; groups: { proposed: Record<string, number> } } }).proposal;
    const top = [...proposal.factors].sort((a, b) => b.coefficient - a.coefficient)[0]!;
    expect(top.factor).toBe("finance_change");
    expect(top.proposed_weight).toBe(5);

    // apply the proposal the way scoring-design does: archive → new version with proposed weights → recompute
    await archiveScoring(ws, ICP);
    const path = join(ws, `icps/${ICP}/scoring.yaml`);
    const doc = YAML.parse(readFileSync(path, "utf8"));
    doc.version = before.version + 1;
    for (const f of doc.factors) f.weight = proposal.factors.find((p) => p.factor === f.id)!.proposed_weight;
    doc.groups = proposal.groups.proposed;
    expect(doc.groups.intent).toBeGreaterThan(before.groups.intent);
    doc.changelog.push({ version: doc.version, date: "2026-10-15", by: "hein", change: "weights from outcome recalibration (40 outcomes)" });
    writeFileSync(path, YAML.stringify(doc));
    const r = await recomputeAll(ws, ICP);
    expect(r.recomputed).toBeGreaterThanOrEqual(N);
    const aucAfter = await totals();
    // Benchmark: an oracle that ranks by the true driver alone (outcomes are noisy, so even it is < 1).
    const oracle = auc(Object.values(truth).map((t) => t.finance), Object.values(truth).map((t) => t.engaged))!;
    expect(aucAfter).toBeGreaterThan(aucBefore + 0.05);
    expect(aucAfter).toBeGreaterThanOrEqual(oracle * 0.9);
  });

  test("win-loss cases: engaged first, with factor levels and notes; CLI wired", async () => {
    const cases = await winLossCases(ws, ICP);
    expect(cases).toHaveLength(N);
    expect(["meeting", "won", "opportunity"]).toContain(cases[0]!.outcome);
    expect(cases[0]!.factor_levels.finance_change).not.toBeUndefined();
    expect(cases[0]!.note).toBe("replied to CFO-change angle");
    const cli = ase(ws, ["outcomes", "stats", "--icp", ICP]);
    expect(JSON.parse(cli.stdout.toString()).accounts_with_outcome).toBe(N);
  });

  test("doctor briefing mentions outcomes", () => {
    const r = ase(ws, ["doctor", "--text"]);
    expect(r.stdout.toString()).toContain(`Outcomes ${ICP}: ${N} accounts`);
  });
});
