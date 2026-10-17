import { expect, test } from "bun:test";
import { ENGINE_DIR, managedDefinition, readAgentFile, researchTask } from "../../src/managed/agents.ts";
import { PLUGIN_ROOT } from "../helpers.ts";

test("agent files become managed definitions: tools mapped, MCP tools via the CLI, plugin root resolved, stable hash", () => {
  const { def, hash } = managedDefinition(readAgentFile(PLUGIN_ROOT, "account-researcher"), "sha1");
  expect(def.name).toBe("ase-account-researcher");
  expect(def.model).toBe("claude-sonnet-5-5");
  expect(def.tools[0]!.default_config).toEqual({ enabled: false, permission_policy: { type: "always_allow" } });
  expect(def.tools[0]!.configs.map((c) => c.name).sort()).toEqual(["bash", "edit", "glob", "grep", "read", "web_fetch", "web_search", "write"]);
  expect(def.system).toContain(`bun ${ENGINE_DIR}/src/cli/ase.ts provider search_news --input`);
  expect(def.system).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  expect(managedDefinition(readAgentFile(PLUGIN_ROOT, "account-researcher"), "other-sha").hash).toBe(hash); // engine sha alone doesn't version the agent
  const judge = managedDefinition(readAgentFile(PLUGIN_ROOT, "factor-judge"), "sha1").def;
  expect(judge.tools[0]!.configs.map((c) => c.name)).toEqual(["read", "glob", "grep"]); // read-only, no provider preamble
  expect(judge.system).not.toContain("Provider tools");
});

test("research task: pinned engine, own branch, two applies, never pushes the base branch", () => {
  const t = researchTask({ repo: "o/shotlift-sales", branch: "managed/x", baseBranch: "master", icp: "i", domains: ["a.com", "b.nl"], engineSha: "abc123", budgetUsd: 1.2, approvedBy: "hein", judgeName: "ase-factor-judge", today: "2026-10-17" });
  expect(t).toContain("git -C /opt/ase checkout -q abc123");
  expect(t).toContain("cd /workspace/shotlift-sales && git checkout -b managed/x");
  expect(t).toContain("git push -q -u origin managed/x");
  expect(t).toContain('"mode": "full", "judgements"');
  expect(t).toContain("Never push to `master`");
  expect(t).not.toContain("${CLAUDE_PLUGIN_ROOT}");
});
