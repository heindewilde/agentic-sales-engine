import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { extractChecks } from "../../src/managed/platform.ts";
import { extractRefs, normalizeWorkspacePath, skillMdFromZip, type AgentVersion } from "../../src/map/data.ts";
import { compactDiff, lineDiff } from "../../src/map/diff.ts";
import { configChanges } from "../../src/map/server.ts";

/** A one-file zip (deflated), like the platform returns for a skill version. */
function zipOf(name: string, text: string): Buffer {
  const data = deflateRawSync(Buffer.from(text));
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(text.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + n.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, data, central, n, eocd]);
}

describe("agent map", () => {
  test("references: engine docs by path, workspace files as one pattern per kind, agents and skills by name", () => {
    const r = extractRefs("Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and /workspace/agentic-sales-engine/methodology/research.md, then `icps/<icp>/scoring.yaml`, `accounts/<d>/brief.md`, accounts/x.com/brief.md and learnings/*.md. Use the factor-judge agent; next: /agentic-sales-engine:ways-in.");
    expect(r.engine).toEqual(["methodology/research.md", "references/rules.md"]);
    expect(r.workspace).toEqual(["accounts/*/brief.md", "icps/*/scoring.yaml", "learnings/*.md"]);
    expect(r.agents).toEqual(["factor-judge"]);
    expect(r.skills).toEqual(["ways-in"]);
    expect(normalizeWorkspacePath("accounts/<d>/drafts/<YYYY-MM-DD>-<person-id>-<channel>.md")).toBe("accounts/*/drafts/*.md");
  });

  test("skill version text comes out of the platform's zip", () => {
    expect(skillMdFromZip(zipOf("research/SKILL.md", "---\nname: research\n---\nbody"))).toBe("---\nname: research\n---\nbody");
    expect(skillMdFromZip(Buffer.from("not a zip"))).toBeNull();
  });

  test("diff: changed lines with context, unchanged runs collapsed", () => {
    const a = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 5", "line five");
    const d = lineDiff(a, b);
    expect(d.filter((l) => l.op === "-").map((l) => l.text)).toEqual(["line 5"]);
    expect(d.filter((l) => l.op === "+").map((l) => l.text)).toEqual(["line five"]);
    const c = compactDiff(d, 1);
    expect(c[0]).toEqual({ op: "…", text: "4 unchanged lines" });
    expect(c.at(-1)).toEqual({ op: "…", text: "3 unchanged lines" });
  });

  test("version changes beyond the prompt: skills, skill versions, tools, model", () => {
    const v = (over: Partial<AgentVersion>): AgentVersion => ({ version: 1, created_at: "", model: "m", system: "s", tools: ["read"], skills: ["lint", "research"], skill_versions: { lint: "a", research: "r" }, subagents: [], runs: 0, cost: 0, checks: 0, ...over });
    expect(configChanges(v({}), v({ version: 2, skill_versions: { lint: "b", research: "r" } }))).toEqual(["new skill version: lint", "system prompt unchanged"]);
    expect(configChanges(v({}), v({ model: "n", tools: ["read", "write"], system: "t" }))).toEqual(["model m → n", "tools added: write"]);
  });

  test("flags: CHECK lines when present, else only list items that ask for a check", () => {
    expect(extractChecks("Done.\nCHECK: a.com headcount is unverified\nCHECK: b.nl positioning is a judgement call\nSTATUS: done")).toEqual(["a.com headcount is unverified", "b.nl positioning is a judgement call"]);
    expect(extractChecks("All three are tier A, but please check the totals in the summary.\n*Please double-check:*\n- Headcount of 14 is unverified for deblonsports.com\n- Two new signals")).toEqual(["Headcount of 14 is unverified for deblonsports.com"]);
  });
});

describe("the brain", () => {
  test("every engine file in a layer; each block's context derived from its playbooks and agent", async () => {
    const { buildBrain } = await import("../../src/map/brain.ts");
    const b = buildBrain(null);
    const layers = new Set(b.files.map((f) => f.layer));
    expect([...layers].sort()).toEqual(["agent", "method", "playbook", "template"]);
    const blocks = new Map(b.steps.flatMap((s) => s.blocks.map((x) => [x.id, x])));
    const research = blocks.get("research-do")!;
    const ids = research.context.map((c) => c.id);
    expect(ids).toContain("engine:agents/account-researcher.md"); // its own instructions
    expect(ids).toContain("engine:skills/research/SKILL.md"); // the playbook
    expect(ids).toContain("digest:rules"); // the rules arrive as the digest in `ase context`, not the whole file
    expect(ids).not.toContain("engine:references/rules.md");
    expect(ids).toContain("engine:references/output-format.md"); // the one description of what it writes
    expect(research.tokens.instructions).toBeGreaterThan(0);
    const judge = blocks.get("research-judge")!;
    expect(judge.context.map((c) => c.id)).toContain("engine:references/judging.md");
    expect(blocks.get("shortlist-approve")!.context).toEqual([]); // your decisions read nothing
    // every block's file is marked as used by it
    expect(b.files.find((f) => f.id === "engine:references/judging.md")!.used_by).toContain("research-judge");
  });
});

test("brain flow: knowledge → method → playbooks → agents → steps, only real references", async () => {
  const { buildBrain } = await import("../../src/map/brain.ts");
  const g = buildBrain(null).graph;
  const col = (id: string) => g.nodes.find((n) => n.id === id)?.col;
  expect(col("p:research")).toBe(2);
  expect(col("a:account-researcher")).toBe(3);
  expect(col("s:research")).toBe(4);
  const has = (from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);
  expect(has("a:account-researcher", "s:research")).toBe(true); // the Researcher works in step 4
  expect(has("p:research", "a:account-researcher")).toBe(true); // following the research playbook
  expect(has("f:engine:references/judging.md", "a:factor-judge")).toBe(true); // the Judge's instructions name the judging rules
  expect(g.edges.every((e) => (col(e.from) ?? 9) < (col(e.to) ?? -1))).toBe(true); // lines only flow left to right
  expect(g.nodes.some((n) => n.ref?.startsWith("engine:templates/"))).toBe(false); // templates fold into playbooks
});
