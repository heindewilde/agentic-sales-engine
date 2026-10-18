import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { credentialsPath, parseEnv } from "../core/credentials.ts";
import { toFile } from "@anthropic-ai/sdk";
import { managedDefinition, operatorDefinition, readAgentFile, runMessage } from "./agents.ts";
import { convertSkill, listSkills } from "./skills.ts";

/**
 * Claude Managed Agents for the owner's own runs (the plugin itself is unchanged). Billed to the Claude Console
 * workspace of ASE_MANAGED_AGENTS_API_KEY, i.e. the Max plan's monthly API credits. That key is deliberately not
 * ANTHROPIC_API_KEY, which would switch the plugin and `claude -p` from the subscription to API billing.
 */

// the plugin's agents; the judge first, because the researcher references it as a subagent
const AGENTS = ["factor-judge", "account-researcher", "icp-analyst", "wiki-linter"] as const;
type AgentName = (typeof AGENTS)[number] | "operator";
type Ref = { id: string; version: number; hash: string };

interface State {
  environment_id?: string;
  vault_id?: string;
  vault_credentials?: string[];
  agents: Partial<Record<AgentName, Ref>>;
  skills?: Record<string, { id: string; version: string; hash: string }>;
  runs?: Record<string, { repo: string; base: string; branch: string; skill: string; args: string }>;
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

  const upsert = async (key: AgentName, body: Record<string, unknown> & { name: string }, hash: string) => {
    const prev = s.agents[key];
    if (prev?.hash === hash) return log(`${body.name}: v${prev.version}, unchanged`);
    const a = prev ? await c.beta.agents.update(prev.id, body as never) : await c.beta.agents.create(body as never);
    s.agents[key] = { id: a.id, version: a.version, hash };
    saveState(s);
    log(`${body.name}: ${prev ? "new version" : "created"} v${a.version} (${a.id})`);
  };
  const pin = (r: Ref) => ({ type: "agent" as const, id: r.id, version: r.version });
  const sub = (agents: ({ type: "agent"; id: string; version: number } | { type: "self" })[]) => ({ type: "multiagent_20261001" as const, subagents: { type: "enabled" as const, inline_agents: { type: "disabled" as const }, predefined_agents: agents } });

  for (const name of AGENTS) {
    const { def, hash } = managedDefinition(readAgentFile(pluginRoot, name), sha);
    // the plugin's agents are subagents of the operator, and subagents can't have their own (max depth 1)
    await upsert(name, { ...def, multiagent: null }, hash);
  }

  // skills: each plugin skill uploaded once, a new version when its text changes
  s.skills ??= {};
  // adopt skills an interrupted sync already created (matched by display name), instead of creating duplicates
  const existing = new Map<string, { id: string; latest_version_id: string }>();
  for await (const k of c.beta.skills.list()) if (k.display_name.startsWith("ase ")) existing.set(k.display_name.slice(4), k);
  for (const name of listSkills(pluginRoot)) {
    const found = existing.get(name);
    if (!s.skills[name] && found) s.skills[name] = { id: found.id, version: found.latest_version_id, hash: "" }; // hash unknown: uploads a fresh version
    const sk = convertSkill(pluginRoot, name);
    const prev = s.skills[name];
    if (prev?.hash === sk.hash) continue;
    const files = [await toFile(Buffer.from(sk.content), `${name}/SKILL.md`)];
    if (prev) {
      const v = await c.beta.skills.versions.create(prev.id, { files });
      s.skills[name] = { id: prev.id, version: v.id, hash: sk.hash };
      log(`skill ${name}: new version`);
      saveState(s);
    } else {
      const created = await c.beta.skills.create({ display_name: `ase ${name}`, files });
      s.skills[name] = { id: created.id, version: created.latest_version_id, hash: sk.hash };
      log(`skill ${name}: created`);
      saveState(s);
    }
  }

  // the operator: every skill, the plugin's agents as subagents, and itself (for parallel chunks)
  const op = operatorDefinition();
  const skills = Object.values(s.skills).map((k) => ({ type: "custom" as const, skill_id: k.id, version: k.version }));
  const subs = AGENTS.map((n) => s.agents[n]).filter((r): r is Ref => Boolean(r)).map(pin);
  const opHash = createHash("sha256").update(JSON.stringify({ op, skills, subs })).digest("hex").slice(0, 16);
  await upsert("operator", { ...op, metadata: { ...op.metadata, engine_sha: sha }, skills, multiagent: sub([...subs, { type: "self" }]) }, opHash);
  saveState(s);
  return s;
}

export interface RunOptions {
  pluginRoot: string;
  repo: string; // owner/name of the workspace repo
  baseBranch: string;
  skill: string;
  args: string;
  capUsd: number; // hard cap on the session's Claude cost
  approvedBy: string;
}

export interface RunResult {
  session_id: string;
  branch: string;
  status: "done" | "question" | "failed" | string;
  message: string; // the agent's last message (the question, or the summary)
  cost_usd: number | null;
  pr: string | null;
}

/** Start a skill on the platform: workspace repo + engine mounted, results on a new branch, a pull request when done. */
export async function run(o: RunOptions, log: (l: string) => void = console.error): Promise<RunResult> {
  const s = await sync(o.pluginRoot, log);
  const c = client();
  const operator = s.agents.operator!;
  const today = new Date().toISOString().slice(0, 10);
  const branch = `managed/${today}-${o.skill}-${Date.now().toString(36).slice(-4)}`;
  const session = await c.beta.sessions.create({
    agent: { type: "agent", id: operator.id, version: operator.version },
    environment_id: s.environment_id!,
    title: `${o.skill} ${o.args}`.trim().slice(0, 200),
    vault_ids: s.vault_id ? [s.vault_id] : [],
    resources: [
      { type: "github_repository", url: `https://github.com/${o.repo}`, authorization_token: secret("ASE_MANAGED_AGENTS_GITHUB_TOKEN"), checkout: { type: "branch", name: o.baseBranch } },
      // the engine at the exact local commit, at /workspace/agentic-sales-engine; mounted repos are cached across sessions
      { type: "github_repository", url: "https://github.com/heindewilde/agentic-sales-engine", checkout: { type: "commit", sha: engineSha(o.pluginRoot) } },
    ],
    budget: { type: "limit", max_list_cost: { amount: String(Math.round(o.capUsd * 100)), currency: "USD" } },
    metadata: { skill: o.skill, branch },
  });
  s.runs = { ...(s.runs ?? {}), [session.id]: { repo: o.repo, base: o.baseBranch, branch, skill: o.skill, args: o.args } };
  saveState(s);
  log(`session ${session.id} → https://platform.claude.com/sessions/${session.id}`);
  return converse(session.id, runMessage({ repo: o.repo, branch, baseBranch: o.baseBranch, skill: o.skill, args: o.args, approvedBy: o.approvedBy, today }), log);
}

/** Answer the question a run is waiting on, and continue it. */
export async function reply(sessionId: string, answer: string, log: (l: string) => void = console.error): Promise<RunResult> {
  return converse(sessionId, answer, log);
}

/** Send one message, stream until the agent stops, and finish the run (pull request) when it says it's done. */
async function converse(sessionId: string, text: string, log: (l: string) => void): Promise<RunResult> {
  const c = client();
  const meta = loadState().runs?.[sessionId];
  if (!meta) throw new Error(`unknown run ${sessionId}`);
  const stream = await c.beta.sessions.events.stream(sessionId); // open before sending: it only delivers later events
  await c.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  let stop = "running";
  let last = "";
  for await (const raw of stream as AsyncIterable<Record<string, unknown>>) {
    const e = raw as { type: string; [k: string]: unknown };
    if (e.type === "agent.message") {
      last = ((e.content as { type: string; text?: string }[]) ?? []).map((b) => b.text ?? "").join("").trim();
      if (last) log(`  agent: ${last.replace(/\s+/g, " ").slice(0, 240)}`);
    } else if (e.type === "agent.tool_use") {
      log(`  ${e.name}: ${JSON.stringify(e.input ?? {}).slice(0, 160)}`);
    } else if (e.type === "session.error") {
      log(`  error: ${JSON.stringify(e.error ?? e).slice(0, 300)}`);
    } else if (e.type === "session.status_idle") {
      stop = ((e.stop_reason as { type?: string }) ?? {}).type ?? "idle";
      break;
    } else if (e.type === "session.status_terminated") {
      stop = "terminated";
      break;
    }
  }
  const final = await c.beta.sessions.retrieve(sessionId);
  const amount = Number((final.usage as { list_cost?: { amount?: string } } | undefined)?.list_cost?.amount ?? NaN) / 100;
  const cost = Number.isFinite(amount) ? amount : null;
  const marker = last.match(/STATUS:\s*(done|question|failed)(?::\s*(.*))?\s*$/i);
  const status = stop !== "end_turn" ? stop : (marker?.[1]?.toLowerCase() ?? "question"); // no marker: treat as a question to you
  const message = last.replace(/\n?STATUS:.*$/i, "").trim();
  const pr = status === "done" ? openPullRequest(meta, sessionId, message, cost, log) : null;
  return { session_id: sessionId, branch: meta.branch, status, message, cost_usd: cost, pr };
}

/** One pull request per finished run: the agent's summary, scores before → after for any rescored account, cost and session link. */
function openPullRequest(m: { repo: string; base: string; branch: string; skill: string; args: string }, sessionId: string, summary: string, cost: number | null, log: (l: string) => void): string | null {
  const gh = (args: string[]) => Bun.spawnSync(["gh", ...args]);
  const cmp = gh(["api", `repos/${m.repo}/compare/${m.base}...${encodeURIComponent(m.branch)}`, "--jq", "[.ahead_by, ([.files[].filename] | join(\"\\n\"))] | @tsv"]);
  if (cmp.exitCode !== 0) {
    log(/Not Found|404/.test(cmp.stderr.toString()) ? "no pull request: nothing changed (the run pushed no branch)" : `no pull request: ${cmp.stderr.toString().trim().slice(0, 200)}`);
    return null;
  }
  const [ahead, files = ""] = cmp.stdout.toString().trim().split("\t");
  if (ahead === "0") {
    log("no pull request: the run changed nothing");
    return null;
  }
  const file = (ref: string, path: string) => {
    const r = gh(["api", `repos/${m.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw"]);
    return r.exitCode === 0 ? r.stdout.toString() : "";
  };
  const field = (text: string, k: string) => text.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.trim() ?? "–";
  const scored = files.split("\\n").filter((f) => /^accounts\/[^/]+\/scores\/[^/]+\.md$/.test(f));
  const rows = scored.map((path) => {
    const [before, after] = [file(m.base, path), file(m.branch, path)];
    const sc = (t: string) => (t ? `${field(t, "mode")} ${field(t, "total")} · ${field(t, "tier")}` : "–");
    return `| ${path.split("/")[1]} | ${sc(before)} | ${sc(after)}${field(after, "timing") !== "–" ? ` · timing ${field(after, "timing")}` : ""} |`;
  });
  const body = [
    `\`${m.skill}${m.args ? ` ${m.args}` : ""}\` on Claude Managed Agents (session [${sessionId}](https://platform.claude.com/sessions/${sessionId})).`,
    "", summary,
    ...(rows.length ? ["", "| Account | Before | After |", "|---|---|---|", ...rows] : []),
    "", `Claude cost: ${cost === null ? "unknown" : `$${cost.toFixed(2)}`} (API credits). Merge to accept, close to discard.`,
  ].join("\n");
  const r = gh(["pr", "create", "--repo", m.repo, "--base", m.base, "--head", m.branch, "--title", `Managed: ${m.skill}${m.args ? ` ${m.args}` : ""}`.slice(0, 120), "--body", body]);
  if (r.exitCode !== 0) {
    log(`pull request not created: ${r.stderr.toString().slice(0, 300)}`);
    return null;
  }
  const url = r.stdout.toString().trim();
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
