import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { credentialsPath } from "../core/credentials.ts";
import { client, extractChecks, managedState } from "../managed/platform.ts";

/**
 * The agent map's model: what exists on Claude Managed Agents (agents, skills, schedules, with their versions), what
 * each is configured with (prompt, skills, the documents they point to), and what the runs cost and flagged.
 * Read-only: everything comes from the platform API and the repo.
 */

export type Kind = "operator" | "agent" | "skill" | "doc" | "schedule";
export interface Edge { from: string; to: string; kind: "subagent" | "attached" | "calls" | "uses-skill" | "reads" | "runs" }

export interface Thread { agent: string; version: number | null; cost: number; output_tokens: number; cache_read: number; active_seconds: number }
export interface Run {
  session_id: string; skill: string; args: string; status: string; created_at: string; cost: number;
  active_minutes: number; operator_version: number | null; agent: string; threads: Thread[]; checks: string[]; archived: boolean;
}
export interface AgentVersion { version: number; created_at: string; model: string; system: string; tools: string[]; skills: string[]; skill_versions: Record<string, string>; subagents: string[]; runs: number; cost: number; checks: number }
export interface AgentNode { key: string; kind: "operator" | "agent"; name: string; id: string; description: string; current: AgentVersion; versions: AgentVersion[]; cost_total: number; runs: number }
export interface SkillVersion { id: string; created_at: string; text: string | null }
export interface SkillNode {
  key: string; kind: "skill"; name: string; id: string; description: string; text: string; versions: SkillVersion[];
  runs: number; cost_total: number; outcomes: Record<string, number>; checks: { session_id: string; created_at: string; text: string }[]; schedule: string | null;
}
export interface DocNode { key: string; kind: "doc"; path: string; scope: "engine" | "workspace"; referenced_by: string[] }
export interface ScheduleNode { key: string; kind: "schedule"; skill: string; id: string; cron: string; timezone: string; cap_usd: number | null; operator_version: number | null; description: string; paused: boolean }
export interface Funnel { icp: string; stages: Record<string, number>; gates: string[] }
export interface MapModel {
  generated_at: string;
  funnel: Funnel[]; // live, from the local workspace (ase doctor), when the map was started with one
  month: { credits_usd: number; runs: number; failed: number; capped: number; questions: number };
  agents: AgentNode[]; skills: SkillNode[]; docs: DocNode[]; schedules: ScheduleNode[]; runs: Run[]; edges: Edge[];
}

const PLUGIN_AGENTS = ["account-researcher", "factor-judge", "icp-analyst", "wiki-linter"];
const cacheDir = () => join(dirname(credentialsPath()), "map-cache");
const usd = (u: unknown) => {
  const a = Number((u as { list_cost?: { amount?: string } } | undefined)?.list_cost?.amount ?? 0);
  return Number.isFinite(a) ? a / 100 : 0;
};
const short = (name: string) => name.replace(/^ase-/, "");

// ---------- references in prompt and skill text ----------

/** Documents a prompt or skill points to: engine docs by path, workspace files as patterns. */
export function extractRefs(text: string): { engine: string[]; workspace: string[]; agents: string[]; skills: string[] } {
  const clean = (p: string) => p.replace(/[`'"),.;:]+$/, "");
  const engine = new Set<string>();
  for (const m of text.matchAll(/(?:\$\{CLAUDE_PLUGIN_ROOT\}\/|\/workspace\/agentic-sales-engine\/|\b)((?:references|methodology|templates)\/[\w./-]+\.\w+)/g)) engine.add(clean(m[1]!));
  const workspace = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/])((?:icps|learnings|accounts|people|team|lists|outcomes|company|imports|ledger|evals|drafts|sync)\/[\w<>*.{}/-]*[\w>*}]\.?\w*)/g)) {
    const p = normalizeWorkspacePath(clean(m[1]!));
    if (/\.\w+$/.test(p) || p.endsWith("/")) workspace.add(p);
  }
  const agents = PLUGIN_AGENTS.filter((a) => new RegExp(`\\b${a}\\b`).test(text));
  const skills = [...new Set([...text.matchAll(/\/agentic-sales-engine:([a-z-]+)/g)].map((m) => m[1]!))];
  return { engine: [...engine].sort(), workspace: [...workspace].sort(), agents, skills };
}

/** One name per workspace file, however a prompt spells the placeholder: accounts/<d>/, accounts/x.com/, icps/<slug>/ → *. */
export function normalizeWorkspacePath(p: string): string {
  return p
    .replace(/<[^>]+>/g, "*")
    .replace(/^(accounts|people|icps|lists|team)\/(?!\*)[^/]+\//, "$1/*/") // a concrete example (accounts/x.com/) is the same file kind
    .replace(/\*-\*(-\*)*/g, "*")
    .replace(/\*+/g, "*");
}

// ---------- skill version text (the platform hands out a zip) ----------

/** The SKILL.md inside a skill version's zip (central directory walk; stored or deflated entries). */
export function skillMdFromZip(buf: Buffer): string | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16);
  const entries = buf.readUInt16LE(eocd + 10);
  for (let e = 0; e < entries && buf.readUInt32LE(p) === 0x02014b50; e++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name.endsWith("SKILL.md")) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function cached<T>(name: string, stamp: string, make: () => Promise<T>): Promise<T> {
  const f = join(cacheDir(), `${name}.json`);
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, "utf8")) as { stamp: string; data: T };
    if (c.stamp === stamp) return Promise.resolve(c.data);
  }
  return make().then((data) => {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(f, JSON.stringify({ stamp, data }));
    return data;
  });
}

// ---------- the model ----------

/** Accounts per stage and open gates, from the local workspace (the same numbers as `ase doctor`). */
export function funnelFrom(workspace: string | undefined): Funnel[] {
  if (!workspace) return [];
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../cli/ase.ts"), "doctor", "--workspace", workspace]);
  try {
    const d = JSON.parse(r.stdout.toString()) as { stages?: Record<string, Record<string, number>>; gates?: string[] };
    return Object.entries(d.stages ?? {}).map(([icp, stages]) => ({ icp, stages, gates: (d.gates ?? []).filter((g) => g.includes(icp)) }));
  } catch {
    return [];
  }
}

export async function buildModel(log: (l: string) => void = () => {}, workspace?: string): Promise<MapModel> {
  const c = client();
  const state = managedState();
  const skillIdToName = new Map(Object.entries(state.skills ?? {}).map(([n, s]) => [s.id, n]));
  const agentIdToName = new Map<string, string>();

  // agents and their versions
  const agents: AgentNode[] = [];
  for (const [key, ref] of Object.entries(state.agents)) {
    if (!ref) continue;
    const versions: AgentVersion[] = [];
    let name = key;
    let description = "";
    for await (const v of c.beta.agents.versions.list(ref.id)) {
      name = v.name;
      description = v.description ?? "";
      const tools = (v.tools ?? []).flatMap((t) => {
        const ts = t as { type: string; configs?: { name: string; enabled?: boolean }[]; default_config?: { enabled?: boolean } };
        if (ts.type !== "agent_toolset_20260401") return [ts.type];
        const on = (ts.configs ?? []).filter((x) => x.enabled !== false).map((x) => x.name);
        return ts.default_config?.enabled ? ["all built-in tools", ...on] : on;
      });
      const subs = ((v.multiagent as { subagents?: { predefined_agents?: ({ id?: string; type: string } | string)[] } } | null)?.subagents?.predefined_agents ?? [])
        .map((a) => (typeof a === "string" ? a : a.type === "self" ? "self" : a.id ?? "?"));
      versions.push({
        version: v.version, created_at: v.created_at, model: typeof v.model === "string" ? v.model : (v.model as { id: string }).id,
        system: v.system ?? "", tools, skills: (v.skills ?? []).map((s) => skillIdToName.get((s as { skill_id: string }).skill_id) ?? (s as { skill_id: string }).skill_id),
        skill_versions: Object.fromEntries((v.skills ?? []).map((s) => { const k = s as { skill_id: string; version?: string | null }; return [skillIdToName.get(k.skill_id) ?? k.skill_id, k.version ?? "latest"]; })),
        subagents: subs, runs: 0, cost: 0, checks: 0,
      });
    }
    versions.sort((a, b) => b.version - a.version);
    agentIdToName.set(ref.id, short(name));
    agents.push({ key: `${key === "operator" ? "operator" : "agent"}:${short(name)}`, kind: key === "operator" ? "operator" : "agent", name: short(name), id: ref.id, description, current: versions[0]!, versions, cost_total: 0, runs: 0 });
  }
  for (const a of agents) for (const v of a.versions) v.subagents = v.subagents.map((s) => (s === "self" ? a.name : agentIdToName.get(s) ?? s));
  log(`agents: ${agents.length}`);

  // skills and their versions (text per version, cached by version id)
  const skills: SkillNode[] = [];
  for (const [name, ref] of Object.entries(state.skills ?? {})) {
    const versions: SkillVersion[] = [];
    for await (const v of c.beta.skills.versions.list(ref.id)) {
      const text = await cached(`skill-${v.id}`, v.id, async () => {
        try {
          const r = await c.beta.skills.versions.download(v.id, { skill_id: ref.id });
          return skillMdFromZip(Buffer.from(await r.arrayBuffer()));
        } catch {
          return null;
        }
      });
      versions.push({ id: v.id, created_at: v.created_at, text });
    }
    versions.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const current = versions.find((v) => v.id === ref.version) ?? versions[0];
    const text = current?.text ?? "";
    const description = text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    skills.push({ key: `skill:${name}`, kind: "skill", name, id: ref.id, description, text, versions, runs: 0, cost_total: 0, outcomes: {}, checks: [], schedule: null });
  }
  log(`skills: ${skills.length}`);

  // schedules
  const schedules: ScheduleNode[] = [];
  for (const [skill, id] of Object.entries(state.deployments ?? {})) {
    const d = await c.beta.deployments.retrieve(id);
    const dd = d as unknown as { schedule?: { expression?: string; timezone?: string }; budget?: { max_list_cost?: { amount?: string } }; agent?: { version?: number }; description?: string; status?: string; paused_at?: string | null };
    schedules.push({
      key: `schedule:${skill}`, kind: "schedule", skill, id, cron: dd.schedule?.expression ?? "", timezone: dd.schedule?.timezone ?? "",
      cap_usd: dd.budget?.max_list_cost?.amount ? Number(dd.budget.max_list_cost.amount) / 100 : null, operator_version: dd.agent?.version ?? null,
      description: dd.description ?? skill, paused: Boolean(dd.paused_at) || dd.status === "paused",
    });
    const sk = skills.find((s) => s.name === skill);
    if (sk) sk.schedule = dd.schedule?.expression ?? null;
  }

  // runs: our sessions (metadata from run/schedule, or the first research runs by branch name)
  const runs: Run[] = [];
  let monthCredits = 0;
  const monthStart = new Date().toISOString().slice(0, 7);
  for await (const s of c.beta.sessions.list({ limit: 100, include_archived: true })) {
    if (s.created_at.startsWith(monthStart)) monthCredits += usd(s.usage);
    const md = (s.metadata ?? {}) as Record<string, string>;
    if (!md.ase_run && !md.branch?.startsWith("managed/")) continue;
    const stamp = `${s.updated_at}|${s.status}`;
    const detail = await cached(`run-${s.id}`, stamp, async () => {
      const threads: Thread[] = [];
      for await (const t of c.beta.sessions.threads.list(s.id)) {
        const u = t.usage as { output_tokens?: number; cache_read_input_tokens?: number; active_seconds?: number } | undefined;
        const ag = t.agent as { name?: string; version?: number; type?: string };
        threads.push({ agent: short(ag.name ?? ag.type ?? "?"), version: ag.version ?? null, cost: usd(t.usage), output_tokens: u?.output_tokens ?? 0, cache_read: u?.cache_read_input_tokens ?? 0, active_seconds: u?.active_seconds ?? 0 });
      }
      let last = "";
      let stop = "";
      for await (const e of c.beta.sessions.events.list(s.id)) {
        if (e.type === "agent.message") last = ((e as { content?: { text?: string }[] }).content ?? []).map((b) => b.text ?? "").join("").trim();
        if (e.type === "session.status_idle") stop = (e as { stop_reason?: { type?: string } }).stop_reason?.type ?? "";
      }
      const marker = last.match(/STATUS:\s*(done|question|failed)/i)?.[1]?.toLowerCase();
      // an archived session reports "terminated"; its real outcome is in how it stopped and the agent's end marker
      const settled = s.status === "idle" || Boolean(s.archived_at);
      const status = !settled ? s.status : stop && stop !== "end_turn" ? stop : marker ?? (md.ase_run ? "question" : "done");
      return { threads, checks: extractChecks(last), status };
    });
    const agent = short(s.agent.name);
    runs.push({
      session_id: s.id, skill: md.skill ?? (s.title?.startsWith("research") ? "research" : s.title?.split(" ")[0] ?? "?"), args: md.args ?? s.title ?? "",
      status: detail.status, created_at: s.created_at, cost: usd(s.usage), active_minutes: Math.round(((s.usage as { active_seconds?: number })?.active_seconds ?? 0) / 6) / 10,
      operator_version: agent === "operator" ? (s.agent.version ?? null) : null, agent, threads: detail.threads, checks: detail.checks, archived: Boolean(s.archived_at),
    });
  }
  runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  log(`runs: ${runs.length}`);

  // roll runs up into agents (per version), skills and the month
  const byName = new Map(agents.map((a) => [a.name, a]));
  for (const r of runs) {
    const sk = skills.find((s) => s.name === r.skill);
    if (sk) {
      sk.runs++;
      sk.cost_total += r.cost;
      sk.outcomes[r.status] = (sk.outcomes[r.status] ?? 0) + 1;
      for (const t of r.checks) sk.checks.push({ session_id: r.session_id, created_at: r.created_at, text: t });
    }
    const top = byName.get(r.agent);
    const topVersion = top?.versions.find((v) => v.version === r.operator_version || (r.operator_version === null && v.version === r.threads.find((t) => t.agent === r.agent)?.version));
    if (topVersion) {
      topVersion.runs++;
      topVersion.cost += r.cost;
      topVersion.checks += r.checks.length;
    }
    // per agent: cost from its own threads, runs counted once per session, and per version from the thread's version
    for (const name of new Set(r.threads.map((t) => t.agent))) {
      const a = byName.get(name);
      if (!a) continue;
      a.runs++;
      if (a.kind === "operator") continue; // the operator's versions were counted from the session above
      for (const v of new Set(r.threads.filter((t) => t.agent === name).map((t) => t.version))) {
        const av = a.versions.find((x) => x.version === v);
        if (av) av.runs++;
      }
    }
    for (const t of r.threads) {
      const a = byName.get(t.agent);
      if (!a) continue;
      a.cost_total += t.cost;
      if (a.kind !== "operator") {
        const av = a.versions.find((x) => x.version === t.version);
        if (av) av.cost += t.cost;
      }
    }
  }

  // edges and documents
  const edges: Edge[] = [];
  const docs = new Map<string, DocNode>();
  const refer = (from: string, text: string) => {
    const r = extractRefs(text);
    for (const [scope, list] of [["engine", r.engine], ["workspace", r.workspace]] as const) {
      for (const p of list) {
        const key = `doc:${p}`;
        if (!docs.has(key)) docs.set(key, { key, kind: "doc", path: p, scope, referenced_by: [] });
        docs.get(key)!.referenced_by.push(from);
        edges.push({ from, to: key, kind: "reads" });
      }
    }
    return r;
  };
  for (const a of agents) {
    refer(a.key, a.current.system);
    for (const sub of a.current.subagents) if (sub !== a.name) edges.push({ from: a.key, to: `agent:${sub}`, kind: "subagent" });
    for (const sk of a.current.skills) edges.push({ from: a.key, to: `skill:${sk}`, kind: "attached" });
  }
  for (const s of skills) {
    const r = refer(s.key, s.text);
    for (const ag of r.agents) edges.push({ from: s.key, to: `agent:${ag}`, kind: "calls" });
    for (const other of r.skills) if (other !== s.name && skills.some((x) => x.name === other)) edges.push({ from: s.key, to: `skill:${other}`, kind: "uses-skill" });
  }
  for (const sc of schedules) edges.push({ from: sc.key, to: `skill:${sc.skill}`, kind: "runs" });

  const month = runs.filter((r) => r.created_at.startsWith(monthStart));
  return {
    generated_at: new Date().toISOString(),
    funnel: funnelFrom(workspace),
    month: {
      credits_usd: Math.round(monthCredits * 100) / 100, runs: month.length,
      failed: month.filter((r) => !["done", "question", "budget_reached", "running", "rescheduling"].includes(r.status)).length,
      capped: month.filter((r) => r.status === "budget_reached").length,
      questions: month.filter((r) => r.status === "question" && !r.archived).length,
    },
    agents, skills, docs: [...docs.values()].sort((a, b) => a.path.localeCompare(b.path)), schedules, runs, edges,
  };
}
