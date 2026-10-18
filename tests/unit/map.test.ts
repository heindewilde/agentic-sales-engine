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
