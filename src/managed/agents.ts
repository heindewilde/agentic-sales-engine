import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDoc } from "../core/frontmatter.ts";

/**
 * The plugin's agents (agents/*.md) as Claude Managed Agents definitions. The repo stays the source of truth: `sync`
 * turns each file into a managed agent, and every change to a file becomes a new immutable version on the platform.
 */

/** Where the engine and the workspace live inside the cloud sandbox. */
// Mounted repos land at /workspace/<repo name> (a custom mount_path is also put under /workspace).
export const ENGINE_DIR = "/workspace/agentic-sales-engine";
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

/**
 * What changes for an agent on the platform: the judge writes its own output file (no caller to return JSON to) and
 * reads one evidence pack instead of searching the workspace.
 */
const MANAGED_EXTRA: Record<string, { tools?: ToolName[]; system?: string }> = {
  "factor-judge": {
    tools: ["write"],
    system: `\n\n## In this environment\nThe caller gives you an evidence pack (\`.ase/tmp/evidence-<domain>.json\`, from \`ase context\`) and the account's \`brief.md\`. Read those two files and \`icps/<icp>/scoring.yaml\`; open a raw snapshot only to confirm a quote you cite. Don't search the workspace. Write your JSON array to the output path the caller gives (nothing else), then reply with one line: the path.`,
  },
};

/** The managed definition for one agent file, plus a hash of it so `sync` only creates a version when something changed. */
export function managedDefinition(file: AgentFile, engineSha: string): { def: ManagedAgentDef; hash: string } {
  const extra = MANAGED_EXTRA[file.name] ?? {};
  const builtins = [...new Set([...file.tools.map((t) => BUILTIN[t]).filter((t): t is ToolName => Boolean(t)), ...(extra.tools ?? [])])];
  const mcp = file.tools.filter((t) => t.startsWith(MCP_PREFIX)).map((t) => t.slice(MCP_PREFIX.length));
  if (mcp.length && !builtins.includes("bash")) builtins.push("bash");
  const system = `${toolPreamble(mcp)}${file.body.replaceAll("${CLAUDE_PLUGIN_ROOT}", ENGINE_DIR)}${extra.system ?? ""}`;
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

/** The research apply file, spelled out so the agent never has to read engine source to find the format. */
const APPLY_EXAMPLE = `{"icp":"<icp>","accounts":[{"domain":"a.com",
  "facts":{"employees":{"value":45,"source_url":"https://a.com/about","confidence":0.8,"raw_ref":"raw/2026-10/abc.md"}},
  "sections":{"Business & offering":"…[^a1]","Situation & triggers":"2026-09-01: … (dated)[^a2]","Technographics":"…","People map":"…","Risks & fit concerns":"…"},
  "sources":{"a1":{"label":"About page","url":"https://a.com/about","date":"<today>","quote":"exact words (≤ 40) from that page","raw_ref":"raw/2026-10/abc.md"}},
  "open_questions":["- [x] Who runs e-commerce? → Jane Doe[^a3]","- [ ] Studio in-house? (unknown after research; owner: ways-in)"],
  "people":[{"name":"Jane Doe","title":"Head of E-commerce","linkedin_url":"https://www.linkedin.com/in/…","persona":"<persona id>","seniority":"director","source_url":"…","confidence":0.8}],
  "signals":[{"type":"launch","title":"…","date":"2026-09-01","source_url":"…","confidence":0.8,"relevance":2,"raw_ref":"raw/…"}],
  "stage":"researched","changelog":"managed research"}]}`;

/** The task for a research run: research and score the accounts, push the results to a branch. The engine is mounted at its commit. */
export function researchTask(o: { repo: string; branch: string; baseBranch: string; icp: string; domains: string[]; budgetUsd: number; approvedBy: string; judgeName: string; today: string }): string {
  const ws = workspaceDir(o.repo);
  const ase = `bun ${ENGINE_DIR}/src/cli/ase.ts`;
  const fastPath = readFileSync(join(import.meta.dir, "../../skills/research/SKILL.md"), "utf8").split("## Fast path")[1]?.replace(/^.*\n/, "").split("\n3. ")[0]?.replaceAll("${CLAUDE_PLUGIN_ROOT}", ENGINE_DIR) ?? "";
  return `Today is ${o.today}. Research and fully score these shortlisted accounts for ICP \`${o.icp}\`: ${o.domains.join(", ")}.
Everything you need is in this message: don't read the engine's source code or other skills.

## 1. Setup (one Bash call)
\`\`\`
(cd ${ENGINE_DIR} && bun install --frozen-lockfile --silent) && cd ${ws} && git checkout -q -b ${o.branch} && ${ase} reindex >/dev/null && ${ase} ledger run start --stage research --icp ${o.icp} --budget ${o.budgetUsd} --approved-by ${o.approvedBy}
\`\`\`
The workspace is \`${ws}\` (git, branch \`${o.baseBranch}\`); the engine is at \`${ENGINE_DIR}\`. Run every \`ase\` command from the workspace.

## 2. Research (the research skill's fast path)
${fastPath.trim()}

## 3. Save the research
Write \`.ase/tmp/research.json\` in this shape (all accounts in one file; footnote ids unique per account, e.g. a letter prefix):
\`\`\`json
${APPLY_EXAMPLE}
\`\`\`
Every web source quotes the exact words its statement rests on and passes its \`raw_ref\`; every number, country, role or date in a
statement must be in one of its footnotes' quotes. No \`judgements\` and no \`mode\` here. Then \`${ase} apply .ase/tmp/research.json\`;
fix and re-apply only the accounts that report errors.

## 4. Score (the \`${o.judgeName}\` agent, one call per account, in parallel)
For each account first run \`${ase} context <domain> --icp ${o.icp} --mode full > .ase/tmp/evidence-<domain>.json\`, then ask \`${o.judgeName}\`:
"Today is ${o.today}. Judge all factors, mode full, ICP ${o.icp} (icps/${o.icp}/scoring.yaml) for <domain>. Evidence:
.ase/tmp/evidence-<domain>.json and accounts/<domain>/brief.md. Write the JSON array to .ase/tmp/judgements-<domain>.json."
Then per account write \`.ase/tmp/score-<domain>.json\` = \`{"icp":"${o.icp}","accounts":[{"domain":"<domain>","mode":"full","judgements":<that array>}]}\`
(a one-line \`jq\` or \`python3\` is fine) and \`${ase} apply\` it: that computes the full score and moves the account to \`scored\`.

## 5. Finish
\`\`\`
${ase} ledger run end && git add -A && git commit -q -m "Managed research: ${o.domains.join(", ")}" && git push -q -u origin ${o.branch}
\`\`\`
Never push to \`${o.baseBranch}\`. End with one line per account (full score, tier, timing, top trigger) and the provider spend.`;
}
