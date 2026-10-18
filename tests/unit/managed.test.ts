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
  expect(judge.tools[0]!.configs.map((c) => c.name)).toEqual(["read", "glob", "grep", "write"]); // writes its own output on the platform
  expect(judge.system).not.toContain("Provider tools");
  expect(judge.system).toContain(".ase/tmp/evidence-<domain>.json");
});

test("research task: pinned engine, own branch, two applies, never pushes the base branch", () => {
  const t = researchTask({ repo: "o/sales-workspace", branch: "managed/x", baseBranch: "master", icp: "i", domains: ["a.com", "b.nl"], budgetUsd: 1.2, approvedBy: "hein", judgeName: "ase-factor-judge", researcherName: "ase-account-researcher", today: "2026-10-17" });
  expect(t).toContain("cd /workspace/sales-workspace && git checkout -q -b managed/x");
  expect(t).toContain("one `ase-account-researcher` subagent per account"); // each account in its own small context
  expect(t).toContain("context <domain> --icp i --mode full > .ase/tmp/evidence-<domain>.json");
  expect(t).toContain("git push -q -u origin managed/x");
  expect(t).toContain('"mode":"full","judgements"');
  const researcher = managedDefinition(readAgentFile(PLUGIN_ROOT, "account-researcher"), "sha1").def;
  expect(researcher.system).toContain('"stage":"researched"'); // the apply format lives in the cached system prompt
  expect(researcher.system).toContain("context <domain> --icp <icp> --mode full");
  expect(t).toContain("Never push to `master`");
  expect(t).not.toContain("${CLAUDE_PLUGIN_ROOT}");
});
