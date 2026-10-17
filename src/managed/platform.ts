import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialsPath, parseEnv } from "../core/credentials.ts";
import { ENGINE_DIR, managedDefinition, readAgentFile, researchTask } from "./agents.ts";

/**
 * Claude Managed Agents for the owner's own runs (the plugin itself is unchanged). Billed to the Claude Console
 * workspace of ASE_MANAGED_AGENTS_API_KEY, i.e. the Max plan's monthly API credits. That key is deliberately not
 * ANTHROPIC_API_KEY, which would switch the plugin and `claude -p` from the subscription to API billing.
 */

const AGENTS = ["factor-judge", "account-researcher"] as const; // judge first: the researcher references it
type AgentName = (typeof AGENTS)[number];

interface State {
  environment_id?: string;
  vault_id?: string;
  vault_credentials?: string[];
  agents: Partial<Record<AgentName, { id: string; version: number; hash: string }>>;
  telemetry_destination_id?: string;
}

const statePath = () => join(dirname(credentialsPath()), "managed.json");
const loadState = (): State => (existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) : { agents: {} });
function saveState(s: State) {
  mkdirSync(dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

/** Read from the credentials file only, never from the environment (so nothing leaks into child processes). */
export function secret(name: string, required = true): string {
  const v = existsSync(credentialsPath()) ? parseEnv(readFileSync(credentialsPath(), "utf8"))[name] : undefined;
  if (!v && required) throw new Error(`${name} is not set in ${credentialsPath()}`);
  return v ?? "";
}

const client = () => new Anthropic({ apiKey: secret("ASE_MANAGED_AGENTS_API_KEY") });

function engineSha(pluginRoot: string): string {
  const r = Bun.spawnSync(["git", "-C", pluginRoot, "rev-parse", "HEAD"]);
  const sha = r.stdout.toString().trim();
  const ahead = Bun.spawnSync(["git", "-C", pluginRoot, "rev-list", "--count", "origin/main..HEAD"]).stdout.toString().trim();
  if (ahead && ahead !== "0") throw new Error(`the sandbox clones the engine from GitHub, but HEAD is ${ahead} commit(s) ahead of origin/main: push first`);
  return sha;
}

/** Environment, vault and agents: create what's missing, version what changed. Idempotent. */
export async function sync(pluginRoot: string, log: (l: string) => void = console.error): Promise<State> {
  const c = client();
  const s = loadState();
  const sha = engineSha(pluginRoot);

  if (!s.environment_id) {
    // Open networking (the owner's choice): research reads any company site, like local runs do.
    const env = await c.beta.environments.create({ name: "ase-research", description: "agentic-sales-engine research sandbox", config: { type: "cloud", networking: { type: "unrestricted" } } });
    s.environment_id = env.id;
    log(`environment ${env.id} created`);
  }

  if (!s.vault_id) {
    const v = await c.beta.vaults.create({ display_name: "ase provider keys" });
    s.vault_id = v.id;
    s.vault_credentials = [];
    // The sandbox only sees a placeholder; the real key is swapped in on requests to that host.
    for (const [name, host] of [["EXA_API_KEY", "api.exa.ai"], ["FIRECRAWL_API_KEY", "api.firecrawl.dev"]] as const) {
      const value = secret(name, false);
      if (!value) continue;
      const cred = await c.beta.vaults.credentials.create(v.id, { display_name: name, auth: { type: "environment_variable", secret_name: name, secret_value: value, networking: { type: "limited", allowed_hosts: [host] }, injection_location: { header: true } } });
      s.vault_credentials.push(cred.id);
    }
    log(`vault ${v.id} created with ${s.vault_credentials.length} provider key(s)`);
  }

  for (const name of AGENTS) {
    const { def, hash } = managedDefinition(readAgentFile(pluginRoot, name), sha);
    const judge = s.agents["factor-judge"];
    const multiagent = name === "account-researcher" && judge
      ? { type: "multiagent_20261001" as const, subagents: { type: "enabled" as const, inline_agents: { type: "disabled" as const }, predefined_agents: [{ type: "agent" as const, id: judge.id, version: judge.version }] } }
      : undefined;
    const prev = s.agents[name];
    // the researcher also needs a new version when it should point at a new judge version
    const fullHash = `${hash}${multiagent ? `:${judge!.id}@${judge!.version}` : ""}`;
    if (prev?.hash === fullHash) {
      log(`${def.name}: v${prev.version}, unchanged`);
      continue;
    }
    const body = { ...def, ...(multiagent ? { multiagent } : {}) };
    const a = prev ? await c.beta.agents.update(prev.id, body) : await c.beta.agents.create(body);
    s.agents[name] = { id: a.id, version: a.version, hash: fullHash };
    log(`${def.name}: ${prev ? "new version" : "created"} v${a.version} (${a.id})`);
  }
  saveState(s);
  return s;
}

export interface RunOptions {
  pluginRoot: string;
  repo: string; // owner/name of the workspace repo
  baseBranch: string;
  icp: string;
  domains: string[];
  budgetUsd: number; // provider (Exa/Firecrawl) budget for the ledger run
  capUsd: number; // hard cap on the session's Claude cost
  approvedBy: string;
}

/** One research session: workspace repo mounted, results pushed to a new branch. Streams progress; returns the branch. */
export async function run(o: RunOptions, log: (l: string) => void = console.error): Promise<{ session_id: string; branch: string; status: string; cost_usd: number | null; pr: string | null }> {
  const s = await sync(o.pluginRoot, log);
  const c = client();
  const researcher = s.agents["account-researcher"]!;
  const today = new Date().toISOString().slice(0, 10);
  const branch = `managed/${today}-${o.domains[0]!.replace(/\..*$/, "")}${o.domains.length > 1 ? `-and-${o.domains.length - 1}` : ""}-${Date.now().toString(36).slice(-4)}`;
  const session = await c.beta.sessions.create({
    agent: { type: "agent", id: researcher.id, version: researcher.version },
    environment_id: s.environment_id!,
    title: `research ${o.domains.join(", ")}`,
    vault_ids: s.vault_id ? [s.vault_id] : [],
    resources: [
      { type: "github_repository", url: `https://github.com/${o.repo}`, authorization_token: secret("ASE_MANAGED_AGENTS_GITHUB_TOKEN"), checkout: { type: "branch", name: o.baseBranch } },
      // the engine at the exact local commit; mounted repos are cached across sessions, so no clone per run
      { type: "github_repository", url: "https://github.com/heindewilde/agentic-sales-engine", mount_path: ENGINE_DIR, checkout: { type: "commit", sha: engineSha(o.pluginRoot) } },
    ],
    budget: { type: "limit", max_list_cost: { amount: String(Math.round(o.capUsd * 100)), currency: "USD" } },
    metadata: { icp: o.icp, branch },
  });
  log(`session ${session.id} → https://platform.claude.com/sessions/${session.id}`);

  const stream = await c.beta.sessions.events.stream(session.id); // open before sending: it only delivers later events
  const task = researchTask({ repo: o.repo, branch, baseBranch: o.baseBranch, icp: o.icp, domains: o.domains, budgetUsd: o.budgetUsd, approvedBy: o.approvedBy, judgeName: "ase-factor-judge", today });
  await c.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: task }] }] });

  let status = "running";
  let cost: number | null = null;
  for await (const raw of stream as AsyncIterable<Record<string, unknown>>) {
    const e = raw as { type: string; [k: string]: unknown };
    if (e.type === "agent.message") {
      const text = ((e.content as { type: string; text?: string }[]) ?? []).map((b) => b.text ?? "").join(" ").trim();
      if (text) log(`  agent: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
    } else if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") {
      const input = JSON.stringify(e.input ?? {});
      log(`  ${e.name}: ${input.slice(0, 160)}`);
    } else if (e.type === "session.error") {
      log(`  error: ${JSON.stringify(e.error ?? e).slice(0, 300)}`);
    } else if (e.type === "session.usage") {
      const lc = (e as { list_cost?: { amount?: string } }).list_cost?.amount;
      if (lc !== undefined) cost = Number(lc) / 100;
    } else if (e.type === "session.status_idle") {
      status = ((e.stop_reason as { type?: string }) ?? {}).type ?? "idle";
      if (status === "requires_action") log("  waiting for an approval: open the session in the Console");
      break;
    } else if (e.type === "session.status_terminated") {
      status = "terminated";
      break;
    }
  }
  const final = await c.beta.sessions.retrieve(session.id);
  cost = Number((final.usage as { list_cost?: { amount?: string } } | undefined)?.list_cost?.amount ?? NaN) / 100;
  const pr = status === "end_turn" ? openPullRequest(o, branch, session.id, cost, log) : null;
  return { session_id: session.id, branch, status, cost_usd: Number.isFinite(cost) ? cost : null, pr };
}

/** One pull request per run: scores before → after per account, with the session link and cost, for review on GitHub. */
function openPullRequest(o: RunOptions, branch: string, sessionId: string, cost: number | null, log: (l: string) => void): string | null {
  const gh = (args: string[]) => Bun.spawnSync(["gh", ...args]);
  const file = (ref: string, path: string) => {
    const r = gh(["api", `repos/${o.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw"]);
    return r.exitCode === 0 ? r.stdout.toString() : "";
  };
  const field = (text: string, k: string) => text.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.trim() ?? "–";
  const rows = o.domains.map((d) => {
    const path = `accounts/${d}/scores/${o.icp}.md`;
    const [before, after] = [file(o.baseBranch, path), file(branch, path)];
    return `| ${d} | ${field(before, "mode")} ${field(before, "total")} · ${field(before, "tier")} | ${field(after, "mode")} ${field(after, "total")} · **${field(after, "tier")}** · timing ${field(after, "timing")} |`;
  });
  const body = [
    `Research and full score by Claude Managed Agents (session [${sessionId}](https://platform.claude.com/sessions/${sessionId})).`,
    "",
    "| Account | Before | After |", "|---|---|---|", ...rows,
    "",
    `Claude cost: ${cost === null || !Number.isFinite(cost) ? "unknown" : `$${cost.toFixed(2)}`} (API credits). Provider spend: see \`ledger/costs.jsonl\` in the diff.`,
    "",
    "Review the briefs, signals and people, then merge to accept or close to discard.",
  ].join("\n");
  const r = gh(["pr", "create", "--repo", o.repo, "--base", o.baseBranch, "--head", branch, "--title", `Managed research: ${o.domains.join(", ")}`, "--body", body]);
  const url = r.stdout.toString().trim();
  if (r.exitCode !== 0) {
    log(`pull request not created: ${r.stderr.toString().slice(0, 300)}`);
    return null;
  }
  log(`pull request: ${url}`);
  return url;
}

/**
 * Send the platform's own traces (every session turn, model request and tool call, with content) to Braintrust.
 * Needs an Admin API key once (ASE_ANTHROPIC_ADMIN_KEY); revoke it afterwards.
 */
export async function connectTelemetry(): Promise<{ id: string; endpoint: string; project_id: string }> {
  const s = loadState();
  const btUrl = (secret("BRAINTRUST_API_URL", false) || "https://api.braintrust.dev").replace(/\/$/, "");
  const btKey = secret("BRAINTRUST_API_KEY");
  const project = secret("BRAINTRUST_PROJECT", false) || "agentic-sales-engine";
  const r = await fetch(`${btUrl}/v1/project`, { method: "POST", headers: { Authorization: `Bearer ${btKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: project }) });
  if (!r.ok) throw new Error(`Braintrust project lookup failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const project_id = ((await r.json()) as { id: string }).id;
  const admin = new Anthropic({ apiKey: secret("ASE_ANTHROPIC_ADMIN_KEY") });
  const d = await admin.beta.organization.telemetryDestinations.create({
    display_name: `Braintrust · ${project}`,
    endpoint_url: `${btUrl}/otel`,
    headers: { Authorization: `Bearer ${btKey}`, "x-bt-parent": `project_id:${project_id}` },
    traces: { content_mode: "content" },
    workspaces: { type: "all" },
  });
  s.telemetry_destination_id = d.id;
  saveState(s);
  return { id: d.id, endpoint: `${btUrl}/otel`, project_id };
}

export const managedState = loadState;
