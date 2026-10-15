import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistCandidates } from "../../src/core/accounts.ts";
import { advance, approveGate, findRun, loadState, startAutopilot } from "../../src/core/autopilot.ts";
import type { ChunkRunner } from "../../src/core/batch.ts";
import { health } from "../../src/core/doctor.ts";
import { readDoc, stringifyDoc } from "../../src/core/frontmatter.ts";
import { appendLedger } from "../../src/core/ledger.ts";
import type { Company } from "../../src/core/schemas.ts";
import { writeScore } from "../../src/core/scorefile.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

const ICP = "ap-automation-midmarket";
const fixture = () => {
  const ws = join(mkdtempSync(join(tmpdir(), "ase-ap-")), "ws");
  cpSync(join(PLUGIN_ROOT, "fixtures/workspace-ledgerly"), ws, { recursive: true });
  return ws;
};
const domainsIn = (prompt: string) => prompt.split("\n")[0]!.match(/[a-z0-9-]+\.example/g) ?? [];
async function setStage(ws: string, d: string, stage: string) {
  const p = join(ws, "accounts", d, "company.md");
  const { data, body } = await readDoc<Company>(p);
  data.icp_status[ICP] = { ...data.icp_status[ICP]!, stage: stage as never };
  writeFileSync(p, stringifyDoc(data, body));
}

/** Scripted world: discover creates N accounts; each batch skill does its stage's work. */
function world(ws: string, opts: { failResearch?: number; costPerChunk?: number } = {}) {
  const calls: string[] = [];
  let researchFailures = opts.failResearch ?? 0;
  const session: ChunkRunner = async ({ prompt }) => {
    calls.push("discover");
    const n = Number(/--target (\d+)/.exec(prompt)?.[1] ?? 3);
    await persistCandidates(ws, ICP, "auto", "test", Array.from({ length: Math.min(n, 4) }, (_, i) => ({ name: `Auto ${i}`, domain: `auto-${i}.example`, source_url: `https://auto-${i}.example` })));
    return { cost_usd: 0.1, ok: true, summary: "ok" };
  };
  const runner: ChunkRunner = async ({ prompt, ws: w }) => {
    const skill = /agentic-sales-engine:([a-z-]+)/.exec(prompt)![1]!;
    calls.push(skill);
    if (opts.costPerChunk) appendLedger(w, { run_id: findRun(w)!.run_id, provider: "anthropic", op: "test", usd: opts.costPerChunk, kind: "actual" });
    for (const [i, d] of domainsIn(prompt).entries()) {
      if (skill === "enrich-light") {
        await writeScore({ ws: w, icp: ICP, domain: d, mode: "light", judgements: [{ id: "industry_fit", level: (3 - (Number(d.match(/\d+/)?.[0] ?? 0) % 2)) as 2 | 3, confidence: 0.9, evidence: [{ quote: "q", source_url: `https://${d}` }] }, { id: "company_size", level: 3, confidence: 0.9, evidence: [{ quote: "q", source_url: `https://${d}` }] }] });
      } else if (skill === "research") {
        if (researchFailures > 0) {
          researchFailures--;
          throw new Error("session crashed");
        }
        await setStage(w, d, "researched");
      } else if (skill === "score") {
        await writeScore({ ws: w, icp: ICP, domain: d, mode: "full", judgements: [{ id: "industry_fit", level: 3, confidence: 0.9, evidence: [{ quote: "q", source_url: `https://${d}` }] }, { id: "company_size", level: 3, confidence: 0.9, evidence: [{ quote: "q", source_url: `https://${d}` }] }, { id: "finance_change", level: 3, confidence: 0.9, evidence: [{ quote: "q", source_url: `https://${d}` }] }] });
      } else if (skill === "ways-in") {
        await setStage(w, d, "outreach_ready");
      } else if (skill === "draft-outreach") {
        mkdirSync(join(w, "accounts", d, "drafts"), { recursive: true });
        writeFileSync(join(w, "accounts", d, "drafts", `2026-10-15-x-email.md`), stringifyDoc({ account: d, icp: ICP, channel: "email", status: "draft", based_on: ["x"], created: "2026-10-15" }, `Hi.[^1]\n\n[^1]: https://${d}\n`));
      }
      void i;
    }
    return { cost_usd: 0, ok: true, summary: "ok" };
  };
  return { calls, deps: { pluginRoot: PLUGIN_ROOT, session, runner, backoffMs: [0, 0], log: () => {} } };
}

describe("autopilot", () => {
  test("refuses an unapproved ICP or a non-member", async () => {
    const ws = fixture();
    await expect(startAutopilot(ws, { icp: "nope", budgetUsd: 5 })).rejects.toThrow(/does not exist/);
    await expect(startAutopilot(ws, { icp: ICP, budgetUsd: 5, by: "mallory" })).rejects.toThrow(/not a member/);
  });

  test("full run: pauses at shortlist, resumes after approval, pauses for draft review, finishes; resume is idempotent", async () => {
    const ws = fixture();
    const { calls, deps } = world(ws);
    let s = await startAutopilot(ws, { icp: ICP, budgetUsd: 10, target: 4, by: "hein" });
    s = await advance(ws, s, deps);
    expect(s.status).toBe("waiting");
    expect(s.gate!.step).toBe("shortlist");
    expect(existsSync(join(ws, s.gate!.file!))).toBe(true);
    expect(s.steps.slice(0, 3).map((x) => x.status)).toEqual(["done", "done", "waiting"]);
    expect((await health(ws)).gates[0]).toContain(`Autopilot ${s.run_id}`);
    // waiting is sticky until a human approves
    expect((await advance(ws, s, deps)).status).toBe("waiting");
    await expect(approveGate(ws, s, "")).rejects.toThrow();

    s = await approveGate(ws, loadState(ws, ICP, s.run_id), "hein");
    s = await advance(ws, s, deps);
    expect(s.status).toBe("waiting");
    expect(s.gate!.step).toBe("score"); // scores are reviewed before ways in / drafts
    expect(s.gate!.message).toMatch(/A · \d+ B/);
    expect(calls).not.toContain("ways-in");
    expect(s.steps.find((x) => x.id === "research")!.summary).toMatch(/researched/);
    s = await advance(ws, await approveGate(ws, s, "hein"), deps);
    expect(s.gate!.step).toBe("drafts");
    s = await approveGate(ws, s, "hein");
    s = await advance(ws, s, deps);
    expect(s.status).toBe("done");
    const before = calls.length;
    await advance(ws, s, deps);
    expect(calls.length).toBe(before); // nothing re-runs
    expect(calls.filter((c) => c === "discover")).toHaveLength(1);
    expect(readFileSync(join(ws, "lists", ICP, s.run_id, "autopilot.json"), "utf8")).toContain('"status": "done"');
  });

  test("retries a failing step, then fails; resume after the fix continues where it stopped", async () => {
    const ws = fixture();
    const w1 = world(ws, { failResearch: 1 });
    let s = await advance(ws, await startAutopilot(ws, { icp: ICP, budgetUsd: 10, target: 4 }), w1.deps);
    s = await advance(ws, await approveGate(ws, s, "hein"), w1.deps);
    expect(s.steps.find((x) => x.id === "research")!.attempts).toBe(2); // failed once, succeeded on retry
    expect(s.gate!.step).toBe("score");

    const ws2 = fixture();
    const w2 = world(ws2, { failResearch: 99 });
    let t = await advance(ws2, await startAutopilot(ws2, { icp: ICP, budgetUsd: 10, target: 4 }), w2.deps);
    t = await advance(ws2, await approveGate(ws2, t, "hein"), w2.deps);
    expect(t.status).toBe("failed");
    expect(t.steps.find((x) => x.id === "research")).toMatchObject({ status: "failed", attempts: 3 });
    expect((await health(ws2)).problems.join()).toContain("failed at research");
    // "fix" the cause and resume (CLI resets failed steps)
    const fixed = world(ws2);
    for (const st of t.steps) if (st.status === "failed") (st.status = "pending"), (st.attempts = 0);
    t.status = "running";
    t = await advance(ws2, t, fixed.deps);
    expect(t.gate!.step).toBe("score");
    expect(fixed.calls).not.toContain("discover");
  });

  test("stops at the budget and waits for an extension", async () => {
    const ws = fixture();
    const { deps } = world(ws, { costPerChunk: 0.4 });
    const s = await advance(ws, await startAutopilot(ws, { icp: ICP, budgetUsd: 0.5, target: 4 }), deps);
    expect(s.status).toBe("waiting");
    expect(s.gate!.message).toMatch(/[Bb]udget/);
  });

  test("--until shortlist stops after the proposal; one autopilot per workspace", async () => {
    const ws = fixture();
    const { deps } = world(ws);
    let s = await startAutopilot(ws, { icp: ICP, budgetUsd: 10, target: 4, until: "shortlist" });
    expect(s.steps.filter((x) => x.status === "skipped").map((x) => x.id)).toEqual(["research", "score", "ways_in", "drafts"]);
    s = await advance(ws, s, deps);
    s = await advance(ws, await approveGate(ws, s, "hein"), deps);
    expect(s.status).toBe("done");

    mkdirSync(join(ws, ".ase"), { recursive: true });
    writeFileSync(join(ws, ".ase/autopilot.lock"), JSON.stringify({ run_id: "other-run", pid: process.pid }));
    const second = await startAutopilot(ws, { icp: ICP, budgetUsd: 1, target: 1 });
    await expect(advance(ws, second, deps)).rejects.toThrow(/already active/);
  });
});
