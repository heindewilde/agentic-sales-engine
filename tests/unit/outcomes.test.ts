import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { persistCandidates } from "../../src/core/accounts.ts";
import { markDraft } from "../../src/core/drafts.ts";
import { stringifyDoc } from "../../src/core/frontmatter.ts";
import { accountStates, logEvent, migrateLegacy, openItems, outcomeStats, readEvents, winLossCases, type OutcomeEvent } from "../../src/core/outcomes.ts";
import { archiveScoring, loadScoring, recomputeAll, runRecalibrate, writeScore } from "../../src/core/scorefile.ts";
import { auc, wilson } from "../../src/core/stats.ts";
import { makeWorkspace, PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const ase = (ws: string, args: string[]) =>
  Bun.spawnSync(["bun", join(PLUGIN_ROOT, "src/cli/ase.ts"), ...args, "--workspace", ws], { env: { ...process.env, CLAUDE_PROJECT_DIR: "", ASE_WORKSPACE: "" } });
const ev = (date: string, type: OutcomeEvent["type"], extra: Partial<OutcomeEvent> = {}): OutcomeEvent =>
  ({ ts: `${date}T09:00:00Z`, date, account: "a.example", icp: ICP, type, source: "manual", ...extra }) as OutcomeEvent;
const state = (events: OutcomeEvent[], asOf: string) => accountStates(events, asOf).get(`a.example|${ICP}`)!;

test("wilson interval matches reference values", () => {
  expect(wilson(2, 3)).toEqual({ rate: 0.667, low: 0.208, high: 0.939 });
  expect(wilson(0, 10).high).toBeCloseTo(0.278, 3);
  expect(wilson(0, 0).rate).toBeNull();
});

describe("derived account state", () => {
  test("silence becomes no_response 21 days after the last touch; a follow-up restarts the clock", () => {
    expect(state([ev("2026-09-01", "sent")], "2026-09-15")).toMatchObject({ status: "open", pending: true, days_since_touch: 14 });
    expect(state([ev("2026-09-01", "sent")], "2026-09-22")).toMatchObject({ status: "no_response", derived_no_response: true, pending: false });
    expect(state([ev("2026-09-01", "sent"), ev("2026-09-20", "sent")], "2026-10-05")).toMatchObject({ status: "open", days_since_touch: 15 });
  });
  test("a late reply overrides silence; engagement survives a later loss", () => {
    expect(state([ev("2026-09-01", "sent"), ev("2026-10-10", "replied_positive")], "2026-10-15")).toMatchObject({ status: "engaged", engaged: true });
    const lostDeal = state([ev("2026-06-01", "sent"), ev("2026-06-05", "meeting_held"), ev("2026-08-01", "lost", { reason: "competitor" })], "2026-10-15");
    expect(lostDeal).toMatchObject({ status: "lost", engaged: true, won: false, reasons: ["competitor"] });
    expect(state([ev("2026-06-01", "sent"), ev("2026-06-02", "replied_negative", { reason: "timing" })], "2026-10-15")).toMatchObject({ status: "not_interested", engaged: false });
    expect(state([ev("2026-06-01", "sent"), ev("2026-06-02", "unsubscribed", { reason: "opted_out" })], "2026-10-15").status).toBe("opted_out");
  });
  test("review queue: stale meetings and 14+ day silences first; resolved accounts drop out", () => {
    const events = [
      ev("2026-10-10", "sent", { account: "fresh.example" }),
      ev("2026-09-28", "sent", { account: "quiet.example" }),
      ev("2026-09-01", "sent", { account: "met.example" }),
      ev("2026-09-10", "meeting_held", { account: "met.example" }),
      ev("2026-08-01", "sent", { account: "dead.example" }),
    ];
    // openItems measures meeting age against today, so pin "as of" for states only and check order by urgency
    const items = openItems(accountStates(events, "2026-10-15"));
    expect(items.map((i) => i.account)).toEqual(["met.example", "quiet.example", "fresh.example"]);
  });
});

describe("logging", () => {
  test("validation: reason codes required for negative outcomes; unsubscribe implies opted_out", () => {
    const ws = makeWorkspace();
    expect(() => logEvent(ws, { account: "a.example", icp: ICP, type: "lost" })).toThrow(/reason code/);
    expect(logEvent(ws, { account: "https://www.A.example/x", icp: ICP, type: "lost", reason: "no_budget" }).account).toBe("a.example");
    expect(logEvent(ws, { account: "a.example", icp: ICP, type: "unsubscribed" }).reason).toBe("opted_out");
    expect(readEvents(ws)).toHaveLength(2);
  });
  test("marking a draft sent logs the first touch exactly once", async () => {
    const rel = "accounts/a.example/drafts/2026-10-01-jane-email.md";
    const ws = makeWorkspace({
      [rel]: stringifyDoc({ account: "a.example", icp: ICP, person: "jane", channel: "email", status: "draft", based_on: ["x"], created: "2026-10-01" }, "Hi[^1]\n\n[^1]: https://a.example\n"),
    });
    const r = await markDraft(ws, rel, "sent", { member: "hein", date: "2026-10-01" });
    expect(r.event).toMatchObject({ type: "sent", person: "jane", channel: "email", draft: rel, member: "hein", source: "draft" });
    await markDraft(ws, rel, "sent");
    expect(readEvents(ws)).toHaveLength(1);
  });
  test("legacy outcomes.csv is read and can be migrated", () => {
    const ws = makeWorkspace({ "outcomes/outcomes.csv": `date,account,icp,member,outcome,note\n2026-05-01,a.example,${ICP},hein,meeting,"good call"\n` });
    expect(readEvents(ws)[0]).toMatchObject({ type: "meeting_held", source: "legacy" });
    expect(migrateLegacy(ws).migrated).toBe(1);
    expect(existsSync(join(ws, "outcomes/outcomes.csv"))).toBe(false);
    expect(readEvents(ws)).toHaveLength(1);
    expect(readEvents(ws)[0]!.source).toBe("migrated");
  });
  test("CLI: log with reason, state", () => {
    const ws = makeWorkspace();
    expect(ase(ws, ["outcome", "log", "a.example", "sent", "--icp", ICP, "--channel", "email", "--date", "2026-09-01"]).exitCode).toBe(0);
    const bad = ase(ws, ["outcome", "log", "a.example", "replied_negative", "--icp", ICP]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("reason code");
    const ok = JSON.parse(ase(ws, ["outcome", "log", "a.example", "replied_negative", "--icp", ICP, "--reason", "timing", "--note", "revisit in Q2"]).stdout.toString());
    expect(ok.state).toEqual({ status: "not_interested", engaged: false });
    expect(JSON.parse(ase(ws, ["outcomes", "state", "a.example"]).stdout.toString())[0].reasons).toEqual(["timing"]);
  });
});

/**
 * Simulated learning loop. Ground truth: accounts engage when finance_change is high (new CFO / ERP change).
 * The v1 model weights fit factors heavily, so it mis-ranks; outcome-based recalibration should fix that.
 */
describe("outcome learning loop (simulated)", () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-oc-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  const N = 40;
  const lv = (x: number) => Math.max(0, Math.min(3, x)) as 0 | 1 | 2 | 3;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const truth: Record<string, { finance: number; engaged: boolean }> = {};

  test("40 full-scored accounts: outreach sent, outcomes logged via the CLI, silence left to the 21-day rule", async () => {
    const domains = Array.from({ length: N }, (_, i) => `acct-${i}.example`);
    await persistCandidates(ws, ICP, "sim", "sim", domains.map((d) => ({ name: d, domain: d, source_url: `https://${d}` })));
    for (const [i, d] of domains.entries()) {
      const finance = Math.floor(rnd() * 4);
      const e = [{ quote: "q", source_url: `https://${d}` }];
      await writeScore({ ws, icp: ICP, domain: d, mode: "full", judgements: [
        { id: "company_size", level: lv(2 + Math.floor(rnd() * 2)), confidence: 0.9, evidence: e },
        { id: "industry_fit", level: lv(Math.floor(rnd() * 4)), confidence: 0.9, evidence: e },
        { id: "erp_fit", level: lv(Math.floor(rnd() * 4)), confidence: 0.7, evidence: e },
        { id: "no_ap_tool", level: lv(1 + Math.floor(rnd() * 3)), confidence: 0.7, evidence: e },
        { id: "finance_change", level: lv(finance), confidence: 0.9, evidence: e },
        { id: "ap_hiring", level: lv(Math.floor(rnd() * 4)), confidence: 0.6, evidence: e },
        { id: "warm_path", level: lv(Math.floor(rnd() * 2)), confidence: 0.8, evidence: e },
        { id: "persona_reachable", level: lv(1 + Math.floor(rnd() * 2)), confidence: 0.8, evidence: e },
      ] });
      if (finance >= 2) {
        mkdirSync(join(ws, `accounts/${d}/signals`), { recursive: true });
        writeFileSync(join(ws, `accounts/${d}/signals/2026-06-01-exec_change.md`), stringifyDoc({ account: d, type: "exec_change", title: "New CFO", date: "2026-06-01", source_url: `https://news.example/${d}`, retrieved_at: "2026-10-15", confidence: 0.9, relevance: { [ICP]: 3 }, ttl_days: 180 }));
      }
      const engaged = finance >= 2 ? rnd() < 0.85 : rnd() < 0.1;
      truth[d] = { finance, engaged };
      const channel = i % 2 ? "email" : "linkedin_connect";
      expect(ase(ws, ["outcome", "log", d, "sent", "--icp", ICP, "--channel", channel, "--member", "hein", "--date", "2026-08-01"]).exitCode).toBe(0);
      if (engaged) {
        ase(ws, ["outcome", "log", d, "replied_positive", "--icp", ICP, "--date", "2026-08-05", "--note", "replied to CFO-change angle"]);
        if (i % 2 === 0) ase(ws, ["outcome", "log", d, "meeting_held", "--icp", ICP, "--date", "2026-08-20"]);
      } else if (i % 3 === 0) {
        ase(ws, ["outcome", "log", d, "replied_negative", "--icp", ICP, "--reason", "no_pain", "--date", "2026-08-04"]);
      } // else: silence → derived no_response (sent 2026-08-01, more than 21 days ago)
    }
    // one account still in flight — must be excluded from conversion statistics
    await persistCandidates(ws, ICP, "sim", "sim", [{ name: "fresh", domain: "fresh.example", source_url: "https://fresh.example" }]);
    ase(ws, ["outcome", "log", "fresh.example", "sent", "--icp", ICP]);
  }, 60_000); // ~80 CLI processes

  test("stats: resolved vs in flight, intervals, by trigger/channel, loss reasons, readiness", async () => {
    const s = await outcomeStats(ws, ICP);
    expect(s.accounts_tracked).toBe(N + 1);
    expect(s.in_flight).toBe(1);
    expect(s.resolved).toBe(N);
    expect(s.overall.engaged).toBe(Object.values(truth).filter((t) => t.engaged).length);
    expect(s.by_status.no_response).toBeGreaterThan(0);
    expect(s.by_trigger.exec_change!.rate!).toBeGreaterThan(s.by_trigger["(none)"]!.rate! + 0.4);
    expect(Object.keys(s.by_channel).sort()).toEqual(["email", "linkedin_connect"]);
    expect(s.loss_reasons.no_pain).toBeGreaterThan(0);
    expect(s.recalibration.ready).toBe(true);
  });

  test("recalibration finds the real driver; applying it improves ranking to near-oracle", async () => {
    const before = await loadScoring(ws, ICP);
    const rankQuality = () => {
      const totals: number[] = [];
      const labels: boolean[] = [];
      for (const d of Object.keys(truth)) {
        totals.push(Number(/^total: ([\d.]+)$/m.exec(readFileSync(join(ws, `accounts/${d}/scores/${ICP}.md`), "utf8"))![1]));
        labels.push(truth[d]!.engaged);
      }
      return auc(totals, labels)!;
    };
    const aucBefore = rankQuality();
    const rec = await runRecalibrate(ws, ICP);
    expect(rec.ready).toBe(true);
    const proposal = (rec as { proposal: { factors: { factor: string; proposed_weight: number; coefficient: number }[]; groups: { proposed: Record<string, number> } } }).proposal;
    expect([...proposal.factors].sort((a, b) => b.coefficient - a.coefficient)[0]!.factor).toBe("finance_change");
    await archiveScoring(ws, ICP);
    const path = join(ws, `icps/${ICP}/scoring.yaml`);
    const doc = YAML.parse(readFileSync(path, "utf8"));
    doc.version = before.version + 1;
    for (const f of doc.factors) f.weight = proposal.factors.find((p) => p.factor === f.id)!.proposed_weight;
    doc.groups = proposal.groups.proposed;
    doc.changelog.push({ version: doc.version, date: "2026-10-15", by: "hein", change: "weights from outcome recalibration" });
    writeFileSync(path, YAML.stringify(doc));
    await recomputeAll(ws, ICP);
    const aucAfter = rankQuality();
    const oracle = auc(Object.values(truth).map((t) => t.finance), Object.values(truth).map((t) => t.engaged))!;
    expect(aucAfter).toBeGreaterThan(aucBefore + 0.05);
    expect(aucAfter).toBeGreaterThanOrEqual(oracle * 0.9);
  });

  test("win-loss cases and doctor reminders", async () => {
    const cases = await winLossCases(ws, ICP);
    expect(cases).toHaveLength(N);
    expect(cases[0]!.engaged).toBe(true);
    expect(cases[0]!.notes).toContain("replied to CFO-change angle");
    expect(cases.some((c) => c.derived_no_response)).toBe(true);
    expect(ase(ws, ["doctor", "--text"]).stdout.toString()).toContain(`Outcomes ${ICP}: ${N + 1} accounts in outreach, ${N} resolved`);
  });
});
