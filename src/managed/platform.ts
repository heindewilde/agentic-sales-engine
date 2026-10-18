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
  deployments?: Record<string, string>; // skill → deployment id
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

export const client = () => new Anthropic({ apiKey: secret("ASE_MANAGED_AGENTS_API_KEY") });

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

  // skills removed or renamed in the repo leave the operator and the platform (a rename would otherwise leave orphans)
  const current = new Set(listSkills(pluginRoot));
  for (const [name, ref] of Object.entries(s.skills)) {
    if (current.has(name)) continue;
    delete s.skills[name];
    saveState(s);
    try {
      for await (const v of c.beta.skills.versions.list(ref.id)) await c.beta.skills.versions.delete(v.id, { skill_id: ref.id });
      await c.beta.skills.delete(ref.id);
      log(`skill ${name}: removed (no longer in the repo)`);
    } catch (e) {
      log(`skill ${name}: dropped from the operator; the platform kept it (${(e as Error).message.slice(0, 120)})`);
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
  checks: string[]; // what the agent says a reviewer should double-check
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
    // everything needed to finish the run later lives on the session itself (inbox, replies, scheduled runs)
    metadata: { ase_run: "1", skill: o.skill, args: o.args.slice(0, 500), branch, repo: o.repo, base: o.baseBranch },
  });
  log(`session ${session.id} → https://platform.claude.com/sessions/${session.id}`);
  return converse(session.id, runMessage({ repo: o.repo, branch, baseBranch: o.baseBranch, skill: o.skill, args: o.args, approvedBy: o.approvedBy, today }), log);
}

/** Answer the question a run is waiting on, and continue it. */
export async function reply(sessionId: string, answer: string, log: (l: string) => void = console.error, fallbackRepo?: string): Promise<RunResult> {
  return converse(sessionId, answer, log, fallbackRepo);
}

/** Send one message, stream until the agent stops, and finish the run (pull request) when it says it's done. */
async function converse(sessionId: string, text: string, log: (l: string) => void, fallbackRepo?: string): Promise<RunResult> {
  const c = client();
  runMeta(await c.beta.sessions.retrieve(sessionId), fallbackRepo); // fail before sending if this isn't one of our runs
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
  return settle(sessionId, stop, last, log, fallbackRepo);
}

type RunMeta = { repo: string; base: string; branch: string; skill: string; args: string };
function runMeta(session: { id: string; metadata?: Record<string, string> | null; title?: string | null }, fallbackRepo?: string): RunMeta {
  const m = session.metadata ?? {};
  const repo = m.repo ?? fallbackRepo; // runs started before the metadata carried the repo
  if (!repo) throw new Error(`session ${session.id} is not an ase run`);
  // scheduled runs have no branch yet: the sandbox names it and the agent reports it (BRANCH: line)
  return { repo, base: m.base ?? "master", branch: m.branch ?? "", skill: m.skill ?? "?", args: m.args ?? session.title?.split(" ").slice(1).join(" ") ?? "" };
}

const costOf = (session: { usage?: unknown }) => {
  const amount = Number((session.usage as { list_cost?: { amount?: string } } | undefined)?.list_cost?.amount ?? NaN) / 100;
  return Number.isFinite(amount) ? amount : null;
};

/** Turn the agent's last message into a result; a finished run gets its pull request (once). */
async function settle(sessionId: string, stop: string, last: string, log: (l: string) => void, fallbackRepo?: string, known?: RunMeta): Promise<RunResult> {
  const session = await client().beta.sessions.retrieve(sessionId);
  const meta = known ? { ...known } : runMeta(session, fallbackRepo);
  const cost = costOf(session);
  const marker = last.match(/STATUS:\s*(done|question|failed)(?::\s*(.*))?\s*$/i);
  const status = stop !== "end_turn" ? stop : (marker?.[1]?.toLowerCase() ?? "question"); // no marker: treat as a question to you
  const named = last.match(/^BRANCH:\s*(\S+)\s*$/m)?.[1]; // scheduled runs name their own branch
  if (named) meta.branch = named;
  if (status === "done" && !meta.branch) log(`no pull request: run ${sessionId} didn't report its branch`);
  const checks = extractChecks(last);
  const message = last.replace(/^CHECK:.*$/gim, "").replace(/\n?BRANCH:.*$/im, "").replace(/\n?STATUS:.*$/i, "").replace(/\n{3,}/g, "\n\n").trim();
  const pr = status === "done" && meta.branch ? openPullRequest(meta, sessionId, message, checks, cost, log) : null;
  return { session_id: sessionId, branch: meta.branch, status, message, checks, cost_usd: cost, pr };
}

/**
 * Runs nobody was listening to (scheduled runs, interrupted commands): open the pull request of every finished one
 * and list the ones waiting on a question. Safe to repeat: a run that already has a pull request keeps it.
 */
export async function inbox(days = 7, log: (l: string) => void = console.error, fallbackRepo?: string): Promise<RunResult[]> {
  const c = client();
  const since = Date.now() - days * 86_400_000;
  const out: RunResult[] = [];
  for await (const s of c.beta.sessions.list({ limit: 100 })) {
    if (Date.parse(s.created_at) < since) break;
    const md = (s.metadata as Record<string, string> | null) ?? {};
    if (!(md.ase_run || (fallbackRepo && md.branch)) || s.archived_at) continue;
    if (s.status !== "idle") {
      out.push({ session_id: s.id, branch: (s.metadata as Record<string, string>).branch ?? "", status: s.status, message: "", checks: [], cost_usd: costOf(s), pr: null });
      continue;
    }
    out.push(await settleFromHistory(s.id, log, fallbackRepo));
  }
  // scheduled runs: their sessions carry the deployment's details, not ours
  for (const depId of Object.values(loadState().deployments ?? {})) {
    const dep = await c.beta.deployments.retrieve(depId);
    const md = (dep.metadata ?? {}) as Record<string, string>;
    const known: RunMeta = { repo: md.repo!, base: md.base ?? "master", branch: "", skill: md.skill ?? "?", args: md.args ?? "" };
    for await (const r of c.beta.deploymentRuns.list({ deployment_id: depId } as never)) {
      if (Date.parse(r.created_at) < since) break;
      if (r.error) {
        out.push({ session_id: r.id, branch: "", status: "failed", message: `scheduled ${known.skill}: ${JSON.stringify(r.error).slice(0, 200)}`, checks: [], cost_usd: null, pr: null });
        continue;
      }
      if (!r.session_id || out.some((x) => x.session_id === r.session_id)) continue;
      const s = await c.beta.sessions.retrieve(r.session_id);
      if (s.status !== "idle") out.push({ session_id: s.id, branch: "", status: s.status, message: `scheduled ${known.skill}`, checks: [], cost_usd: costOf(s), pr: null });
      else out.push(await settleFromHistory(s.id, log, undefined, known));
    }
  }
  return out;
}

async function settleFromHistory(sessionId: string, log: (l: string) => void, fallbackRepo?: string, known?: RunMeta): Promise<RunResult> {
  let last = "";
  let stop = "end_turn";
  for await (const e of client().beta.sessions.events.list(sessionId)) {
    if (e.type === "agent.message") last = ((e as { content?: { text?: string }[] }).content ?? []).map((b) => b.text ?? "").join("").trim();
    if (e.type === "session.status_idle") stop = ((e as { stop_reason?: { type?: string } }).stop_reason?.type) ?? "end_turn";
  }
  return settle(sessionId, stop, last, log, fallbackRepo, known);
}

/**
 * Run a skill on a schedule (cron, Europe/Amsterdam): a platform deployment with the same setup as `run`. Each run
 * works on its own branch; `inbox` turns finished ones into pull requests. Re-run after `sync` to pin the new versions.
 */
export async function schedule(o: Omit<RunOptions, "capUsd"> & { capUsd: number; cron: string; timezone?: string }, log: (l: string) => void = console.error): Promise<{ deployment_id: string; skill: string; cron: string }> {
  const s = await sync(o.pluginRoot, log);
  const c = client();
  const operator = s.agents.operator!;
  const body = {
    name: `ase ${o.skill}`,
    description: `${o.skill} ${o.args}`.trim().slice(0, 500),
    agent: { type: "agent" as const, id: operator.id, version: operator.version },
    environment_id: s.environment_id!,
    vault_ids: s.vault_id ? [s.vault_id] : [],
    resources: [
      { type: "github_repository" as const, url: `https://github.com/${o.repo}`, authorization_token: secret("ASE_MANAGED_AGENTS_GITHUB_TOKEN"), checkout: { type: "branch" as const, name: o.baseBranch } },
      // deployments require a token on every repo; a fine-grained token can always read public repos
      { type: "github_repository" as const, url: "https://github.com/heindewilde/agentic-sales-engine", authorization_token: secret("ASE_MANAGED_AGENTS_GITHUB_TOKEN"), checkout: { type: "commit" as const, sha: engineSha(o.pluginRoot) } },
    ],
    initial_events: [{ type: "user.message" as const, content: [{ type: "text" as const, text: runMessage({ repo: o.repo, baseBranch: o.baseBranch, skill: o.skill, args: o.args, approvedBy: o.approvedBy }) }] }],
    schedule: { type: "cron" as const, expression: o.cron, timezone: o.timezone ?? "Europe/Amsterdam" },
    budget: { type: "limit" as const, max_list_cost: { amount: String(Math.round(o.capUsd * 100)), currency: "USD" } },
    metadata: { ase_run: "1", skill: o.skill, args: o.args.slice(0, 500), repo: o.repo, base: o.baseBranch },
  };
  const prev = s.deployments?.[o.skill];
  const d = prev ? await c.beta.deployments.update(prev, body as never) : await c.beta.deployments.create(body as never);
  s.deployments = { ...(s.deployments ?? {}), [o.skill]: d.id };
  saveState(s);
  log(`${prev ? "updated" : "scheduled"} ${o.skill}: ${o.cron} (${d.id})`);
  return { deployment_id: d.id, skill: o.skill, cron: o.cron };
}

/** One pull request per finished run: the agent's summary, scores before → after for any rescored account, cost and session link. */
/**
 * What the agent flags for review: its `CHECK:` lines. Runs from before that convention fall back to bullets and
 * sentences that ask for a check (check / verify / unverified / caution / guess / borderline / weak).
 */
export function extractChecks(text: string): string[] {
  const tagged = [...text.matchAll(/^\s*CHECK:\s*(.+)$/gim)].map((m) => m[1]!.trim());
  if (tagged.length) return tagged;
  const hint = /\b(double-check|check|verify|unverified|caution|guess|borderline|weak|thin evidence|not confirmed)\b/i;
  // only list items: summaries and headings mention "check" too, but aren't items to check
  return text.split("\n").filter((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)).map((l) => l.replace(/^\s*([-*•]|\d+\.)\s+/, "").replace(/\*\*/g, "").trim())
    .filter((l) => l.length > 15 && l.length < 300 && !l.endsWith(":") && hint.test(l)).slice(0, 12);
}

function openPullRequest(m: RunMeta, sessionId: string, summary: string, checks: string[], cost: number | null, log: (l: string) => void): string | null {
  const gh = (args: string[]) => Bun.spawnSync(["gh", ...args]);
  const existing = gh(["pr", "list", "--repo", m.repo, "--head", m.branch, "--state", "all", "--json", "url", "--jq", ".[0].url // empty"]).stdout.toString().trim();
  if (existing) return existing;
  const cmp = gh(["api", `repos/${m.repo}/compare/${m.base}...${encodeURIComponent(m.branch)}`, "--jq", "[.ahead_by, ([.files[].filename] | join(\"\\n\"))] | @tsv"]);
  if (cmp.exitCode !== 0) {
    log(/Not Found|404/.test(cmp.stderr.toString()) ? "no pull request: nothing changed (the run pushed no branch)" : `no pull request: ${cmp.stderr.toString().trim().slice(0, 200)}`);
    return null;
  }
  const [ahead, files = ""] = cmp.stdout.toString().trim().split("\t");
  if (ahead === "0") {
    // the agent pushed a branch without commits: remove it, so only reviewable branches remain
    gh(["api", "-X", "DELETE", `repos/${m.repo}/git/refs/heads/${m.branch}`]);
    log("no pull request: the run changed nothing (empty branch removed)");
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
    ...(checks.length ? ["", "**Double-check:**", ...checks.map((c) => `- [ ] ${c}`)] : []),
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
