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

/** The research apply file, spelled out so the agent never has to read engine source to find the format. */
const APPLY_EXAMPLE = `{"icp":"<icp>","accounts":[{"domain":"a.com",
  "facts":{"employees":{"value":45,"source_url":"https://a.com/about","confidence":0.8,"raw_ref":"raw/2026-10/abc.md"}},
  "sections":{"Business & offering":"…[^a1]","Situation & triggers":"2026-09-01: … (dated)[^a2]","Technographics":"…","People map":"…","Risks & fit concerns":"…"},
  "sources":{"a1":{"label":"About page","url":"https://a.com/about","date":"<today>","quote":"exact words (≤ 40) from that page","raw_ref":"raw/2026-10/abc.md"}},
  "open_questions":["- [x] Who runs e-commerce? → Jane Doe[^a3]","- [ ] Studio in-house? (unknown after research; owner: ways-in)"],
  "people":[{"name":"Jane Doe","title":"Head of E-commerce","linkedin_url":"https://www.linkedin.com/in/…","persona":"<persona id>","seniority":"director","source_url":"…","confidence":0.8}],
  "signals":[{"type":"launch","title":"…","date":"2026-09-01","source_url":"…","confidence":0.8,"relevance":2,"raw_ref":"raw/…"}],
  "stage":"researched","changelog":"managed research"}]}`;

/**
 * What changes for an agent on the platform: the judge writes its own output file (no caller to return JSON to) and
 * reads one evidence pack instead of searching the workspace.
 */
const MANAGED_EXTRA: Record<string, { tools?: ToolName[]; system?: string }> = {
  "account-researcher": {
    system: `\n\n## In this environment\nA coordinator gives you ONE domain, the ICP and today's date. Work in the workspace directory.
- Start with \`bun ${ENGINE_DIR}/src/cli/ase.ts context <domain> --icp <icp> --mode full\`: it digests the rules, the ICP, the factors with their evidence hints, the learnings and the account's current files. Don't read those files separately, and don't read the engine's source code.
- Keep tool output small, because everything you read stays in your context: \`fetch_pages\` with \`max_chars\` 1500 and a \`focus\`, and \`| head\` on long output. For an exact quote, \`grep\` the saved page (its \`raw_ref\`) instead of fetching again.
- Research with the plan above, then write \`.ase/tmp/research-<domain>.json\` in exactly this shape (no \`judgements\`, no \`mode\`):
\`\`\`json
${APPLY_EXAMPLE}
\`\`\`
  Every web source quotes the exact words (≤ 40) its statement rests on and passes its \`raw_ref\`; every number, country, role or date in a statement must be in one of its footnotes' quotes.
- \`bun ${ENGINE_DIR}/src/cli/ase.ts apply .ase/tmp/research-<domain>.json\`; fix and re-apply until it reports ok.
- Reply to the coordinator with one line: the top trigger, and anything a reviewer should double-check.`,
  },
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


const ALL_OPS = ["discover_companies", "find_people", "search_news", "fetch_pages", "extract", "research", "estimate", "status"];

/**
 * The operator: on the platform it plays the part of the Claude Code session that runs the plugin. It has every
 * skill, can call the four agents, and knows what differs in the sandbox.
 */
export function operatorDefinition(): ManagedAgentDef {
  const ase = `bun ${ENGINE_DIR}/src/cli/ase.ts`;
  const system = `You run the agentic sales engine for a B2B team, unattended, in a cloud sandbox. The user's request names a skill
(\`/agentic-sales-engine:<name>\` or just \`<name>\`) with arguments; follow that skill's instructions exactly. A skill that
points to another skill (\`/agentic-sales-engine:<other>\`) means that skill.

## Environment
- Workspace: the git repo under \`/workspace/\` named in the request. Run every \`ase\` command from there.
- Engine: \`${ENGINE_DIR}\` (its references/, methodology/, templates/ are what the skills call \`\${CLAUDE_PLUGIN_ROOT}\`).
- CLI: \`${ase}\` ("\`ase\`" in the skills).

${toolPreamble(ALL_OPS)}- \`sync_watchlist\` → \`${ase} sync\` (with \`--icp\` / \`--account\` as given)

## What differs from the plugin
- **No \`batch.ts\`, no \`claude -p\`, no \`AskUserQuestion\`.** Instead:
  - **Research** (any number of accounts): you coordinate and keep your own context small. Start one \`ase-account-researcher\`
    subagent per account, all at once ("Research <domain> for ICP <icp>. Today is <date>. Write and apply
    .ase/tmp/research-<domain>.json as your instructions describe, then reply with one line."). Then per account run
    \`${ase} context <domain> --icp <icp> --mode full > .ase/tmp/evidence-<domain>.json\` and ask \`ase-factor-judge\`, all at once:
    "Today is <date>. Judge all factors, mode full, ICP <icp> (icps/<icp>/scoring.yaml) for <domain>. Evidence:
    .ase/tmp/evidence-<domain>.json and accounts/<domain>/brief.md. Write the JSON array to .ase/tmp/judgements-<domain>.json."
    Then per account: \`python3 -c 'import json,sys;i,d=sys.argv[1:];json.dump({"icp":i,"accounts":[{"domain":d,"mode":"full","judgements":json.load(open(f".ase/tmp/judgements-{d}.json"))}]},open(f".ase/tmp/score-{d}.json","w"))' <icp> <domain> && ${ase} apply .ase/tmp/score-<domain>.json\`.
  - **Light enrichment** of more than 10 accounts: split them into chunks of 10 and give each chunk to an \`ase-operator\`
    subagent, all at once ("Run the enrich-light fast path for ICP <icp> on: <domains>. Today is <date>. Apply, then reply with one line.").
  - **Questions and gates** (approvals, choices, anything the skill would ask): ask in plain text, with numbered options when
    there are choices, then stop and end your message with the line \`STATUS: question\`. The answer arrives as the next message.
- Approvals you record (\`--approved-by\`) use the member the request names as approver.

## Finishing
When the work is done, commit everything on the current branch and push it:
\`git add -A && git commit -q -m "<skill>: <one line>" && git push -q -u origin HEAD\` (nothing to commit is fine). Never push to
the base branch. End with a short summary for the reviewer (what changed, spend). Then put every item the reviewer should
double-check (an unverified number, a weak source, a judgement call, a guess) on its own line starting with \`CHECK: \`,
naming the account or file. Then the line \`BRANCH: <the run's branch>\`, then \`STATUS: done\`, or
\`STATUS: failed: <reason>\` if you could not finish.`;
  return {
    name: "ase-operator",
    description: "Runs the agentic sales engine's skills unattended: the platform counterpart of the Claude Code session that runs the plugin.",
    model: MODELS.sonnet!,
    system,
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_allow" } }, configs: [] }],
    metadata: { source: "src/managed/agents.ts (operator)" },
  };
}

/** The first message of a run: set up the sandbox, then the skill with its arguments. */
export function runMessage(o: { repo: string; branch?: string; baseBranch: string; skill: string; args: string; approvedBy: string; today?: string }): string {
  const ws = workspaceDir(o.repo);
  // scheduled runs reuse one message, so the date and a unique branch are worked out in the sandbox
  const branch = o.branch ?? `managed/$(date +%F)-${o.skill}-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \\n')`;
  return `${o.today ? `Today is ${o.today}.` : "Today's date: run `date +%F`."} Workspace: \`${ws}\` (branch \`${o.baseBranch}\`). Approver for gates: \`${o.approvedBy}\`.

Setup first, in one Bash call:
\`(cd ${ENGINE_DIR} && bun install --frozen-lockfile --silent) && cd ${ws} && git checkout -q -b "${branch}" && git branch --show-current && bun ${ENGINE_DIR}/src/cli/ase.ts reindex >/dev/null && mkdir -p .ase/tmp && echo 'export ASE_CLAUDE_BILLING=api' | tee -a ~/.bashrc ~/.profile >/dev/null && echo ok\`
(Claude is billed per token here, not on a subscription: \`ase\` needs \`ASE_CLAUDE_BILLING=api\` in every shell.)

Then: \`/agentic-sales-engine:${o.skill}${o.args ? ` ${o.args}` : ""}\``;
}
