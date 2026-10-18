import { expect, test } from "bun:test";
import { ENGINE_DIR, managedDefinition, operatorDefinition, readAgentFile, runMessage } from "../../src/managed/agents.ts";
import { convertSkill, listSkills } from "../../src/managed/skills.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

test("agent files become managed definitions: tools mapped, MCP tools via the CLI, plugin root resolved, stable hash", () => {
  const { def, hash } = managedDefinition(readAgentFile(PLUGIN_ROOT, "account-researcher"), "sha1");
  expect(def.name).toBe("ase-account-researcher");
  expect(def.model).toBe("claude-sonnet-5-5");
  expect(def.tools[0]!.default_config).toEqual({ enabled: false, permission_policy: { type: "always_allow" } });
  expect(def.tools[0]!.configs.map((c) => c.name).sort()).toEqual(["bash", "glob", "grep", "read", "web_fetch", "web_search", "write"]); // writes one apply file, edits nothing
  expect(def.system).toContain(`bun ${ENGINE_DIR}/src/cli/ase.ts provider search_news --input`);
  expect(def.system).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  expect(managedDefinition(readAgentFile(PLUGIN_ROOT, "account-researcher"), "other-sha").hash).toBe(hash); // engine sha alone doesn't version the agent
  const judge = managedDefinition(readAgentFile(PLUGIN_ROOT, "factor-judge"), "sha1").def;
  expect(judge.tools[0]!.configs.map((c) => c.name)).toEqual(["read", "glob", "grep", "write"]); // writes its own output on the platform
  expect(judge.system).not.toContain("Provider tools");
  expect(judge.system).toContain(".ase/tmp/evidence-<domain>.json");
});

test("operator: every provider op via the CLI, research and enrich-light recipes, questions and finish markers", () => {
  const op = operatorDefinition();
  for (const o of ["discover_companies", "find_people", "search_news", "fetch_pages", "extract", "research"]) expect(op.system).toContain(`provider ${o} --input`);
  expect(op.system).toContain("one `ase-account-researcher`\n    subagent per account");
  expect(op.system).toContain("chunks of 10");
  expect(op.system).toContain("STATUS: question");
  expect(op.system).toContain("STATUS: done");
  const m = runMessage({ repo: "o/sales-workspace", branch: "managed/x", baseBranch: "master", skill: "ways-in", args: "acme.com --icp i", approvedBy: "hein", today: "2026-10-18" });
  expect(m).toContain('git checkout -q -b "managed/x"');
  expect(runMessage({ repo: "o/r", baseBranch: "master", skill: "sync", args: "", approvedBy: "hein" })).toContain("managed/$(date +%F)-sync-"); // scheduled: branch made in the sandbox
  expect(m).toContain("/agentic-sales-engine:ways-in acme.com --icp i");
  expect(m).toContain("Approver for gates: `hein`");
});

test("skills convert to platform skills: same body with the engine path, plugin-only frontmatter dropped", () => {
  const names = listSkills(PLUGIN_ROOT);
  expect(names).toContain("research");
  expect(names.length).toBeGreaterThan(20);
  for (const n of names) {
    const s = convertSkill(PLUGIN_ROOT, n);
    expect(s.content).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(s.content).not.toContain("allowed-tools");
    expect(s.content).toMatch(new RegExp(`^---\\nname: ${n}\\n`));
  }
});
