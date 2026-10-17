import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDoc } from "../core/frontmatter.ts";

/**
 * The plugin's agents (agents/*.md) as Claude Managed Agents definitions. The repo stays the source of truth: `sync`
 * turns each file into a managed agent, and every change to a file becomes a new immutable version on the platform.
 */

/** Where the engine and the workspace live inside the cloud sandbox. */
export const ENGINE_DIR = "/opt/ase";
export const workspaceDir = (repo: string) => `/workspace/${repo.split("/").pop()}`;

export const MODELS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

/** Plugin tool names → the managed agent toolset; the ase MCP tools become CLI calls through bash. */
type ToolName = "read" | "write" | "edit" | "glob" | "grep" | "bash" | "web_search" | "web_fetch";
const BUILTIN: Record<string, ToolName> = { Read: "read", Write: "write", Edit: "edit", Glob: "glob", Grep: "grep", Bash: "bash", WebSearch: "web_search", WebFetch: "web_fetch" };
const MCP_PREFIX = "mcp__plugin_agentic-sales-engine_ase__";

export interface AgentFile {
  name: string;
  description: string;
  model: string;
  tools: string[];
  body: string;
}

export function readAgentFile(pluginRoot: string, name: string): AgentFile {
  const doc = parseDoc<{ name?: string; description?: string; model?: string; tools?: string }>(readFileSync(join(pluginRoot, "agents", `${name}.md`), "utf8"));
  return {
    name: doc.data.name ?? name,
    description: doc.data.description ?? "",
    model: doc.data.model ?? "sonnet",
    tools: (doc.data.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    body: doc.body.trim(),
  };
}

/** How the plugin's MCP tools are reached in the sandbox: the same gateway, through the CLI. */
export function toolPreamble(mcpTools: string[]): string {
  if (!mcpTools.length) return "";
  const ops = mcpTools.filter((t) => t !== "status" && t !== "estimate");
  return [
    "## Provider tools in this environment",
    `The \`${MCP_PREFIX}*\` tools named below are not MCP tools here. Call the same gateway through the CLI, one command per Bash call, from the workspace directory:`,
    ...ops.map((op) => `- \`${op}\` → \`bun ${ENGINE_DIR}/src/cli/ase.ts provider ${op} --input '<the same JSON input>'\``),
    ...(mcpTools.includes("estimate") ? [`- \`estimate\` → add \`--estimate\` to the provider command`] : []),
    ...(mcpTools.includes("status") ? [`- \`status\` → \`bun ${ENGINE_DIR}/src/cli/ase.ts ledger report\``] : []),
    "Provider API keys are already configured; never print or echo them.",
    "",
  ].join("\n");
}

export interface ManagedAgentDef {
  name: string;
  description: string;
  model: string;
  system: string;
  tools: { type: "agent_toolset_20260401"; default_config: { enabled: boolean; permission_policy: { type: "always_allow" } }; configs: { name: ToolName; enabled: boolean }[] }[];
  metadata: Record<string, string>;
}

/** The managed definition for one agent file, plus a hash of it so `sync` only creates a version when something changed. */
export function managedDefinition(file: AgentFile, engineSha: string): { def: ManagedAgentDef; hash: string } {
  const builtins = [...new Set(file.tools.map((t) => BUILTIN[t]).filter((t): t is ToolName => Boolean(t)))];
  const mcp = file.tools.filter((t) => t.startsWith(MCP_PREFIX)).map((t) => t.slice(MCP_PREFIX.length));
  if (mcp.length && !builtins.includes("bash")) builtins.push("bash");
  const system = `${toolPreamble(mcp)}${file.body.replaceAll("${CLAUDE_PLUGIN_ROOT}", ENGINE_DIR)}`;
  const def: ManagedAgentDef = {
    name: `ase-${file.name}`,
    description: file.description.slice(0, 2000),
    model: MODELS[file.model] ?? file.model,
    system,
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false, permission_policy: { type: "always_allow" } }, configs: builtins.map((name) => ({ name, enabled: true })) }],
    metadata: { source: `agents/${file.name}.md` },
  };
  const hash = createHash("sha256").update(JSON.stringify(def)).digest("hex").slice(0, 16);
  def.metadata.source_hash = hash;
  def.metadata.engine_sha = engineSha;
  return { def, hash };
}

/** The task for a research run: set up the engine, research and score the accounts, push the results to a branch. */
export function researchTask(o: { repo: string; branch: string; baseBranch: string; icp: string; domains: string[]; engineSha: string; budgetUsd: number; approvedBy: string; judgeName: string; today: string }): string {
  const ws = workspaceDir(o.repo);
  const ase = `bun ${ENGINE_DIR}/src/cli/ase.ts`;
  return `Today is ${o.today}. Research and fully score these shortlisted accounts for ICP \`${o.icp}\`: ${o.domains.join(", ")}.

## Setup (once, before anything else)
\`\`\`
git clone -q https://github.com/heindewilde/agentic-sales-engine ${ENGINE_DIR} && git -C ${ENGINE_DIR} checkout -q ${o.engineSha} && (cd ${ENGINE_DIR} && bun install --frozen-lockfile)
cd ${ws} && git checkout -b ${o.branch} && ${ase} reindex
${ase} ledger run start --stage research --icp ${o.icp} --budget ${o.budgetUsd} --approved-by ${o.approvedBy}
\`\`\`
The workspace is \`${ws}\` (a git repo, branch \`${o.baseBranch}\`). Run every \`ase\` command from there.

## Work
Follow the research skill's fast path below, with one change: **scoring is done by the \`${o.judgeName}\` agent, in two applies.**
1. Your research JSON (step 3) has no \`judgements\` and no \`mode\`; keep \`"stage": "researched"\`. \`ase apply\` it.
2. Then, per account, delegate to \`${o.judgeName}\`: give it today's date, \`icps/${o.icp}/scoring.yaml\`, mode \`full\`, and the
   account's now-updated evidence files (company.md, brief.md, signals/, people/, the raw snapshots they cite).
3. Write \`.ase/tmp/score-<domain>.json\` = \`{"icp": "${o.icp}", "accounts": [{"domain": "<domain>", "mode": "full", "judgements": <its JSON>}]}\`
   and \`ase apply\` it: that computes the full score and moves the account to \`scored\`.

${readFileSync(join(import.meta.dir, "../../skills/research/SKILL.md"), "utf8").split("## Fast path")[1]?.replace(/^.*\n/, "").replaceAll("${CLAUDE_PLUGIN_ROOT}", ENGINE_DIR) ?? ""}

## Finish
\`\`\`
${ase} ledger run end
cd ${ws} && git add -A && git commit -q -m "Managed research: ${o.domains.join(", ")}" && git push -q -u origin ${o.branch}
\`\`\`
Never push to \`${o.baseBranch}\`. End with one line per account (full score, tier, top trigger) and the provider spend.`;
}
