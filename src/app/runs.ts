import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeBilling } from "../core/billing.ts";
import { BATCH_SKILLS, UNATTENDED_NOTE, defaultRunner, runBatch, type BatchSkill, type ChunkRunner } from "../core/batch.ts";
import { reindexAll } from "../core/db.ts";
import { appendLedger } from "../core/ledger.ts";

/**
 * Runs started from the app. Local runs use your Claude subscription on this Mac (the batch runner for the per-account
 * stages, one headless session for the rest); cloud runs go to Managed Agents (API credits) and come back as a pull
 * request. Each job keeps its log lines and streams them to whoever watches; one local job at a time, so local runs
 * never compete for your plan's usage. Finished jobs are kept in <workspace>/.ase/app-runs.jsonl.
 */

/** What can be started from the app, and how it runs locally. */
export const SKILLS: Record<string, { label: string; local: "batch" | "session"; perAccount: boolean; cloud: boolean }> = {
  discover: { label: "Find companies", local: "session", perAccount: false, cloud: true },
  "enrich-light": { label: "Quick scan + light score", local: "batch", perAccount: true, cloud: true },
  shortlist: { label: "Propose a shortlist", local: "session", perAccount: false, cloud: true },
  research: { label: "Deep research + full score", local: "batch", perAccount: true, cloud: true },
  score: { label: "Rescore", local: "batch", perAccount: true, cloud: true },
  "ways-in": { label: "Ways in", local: "batch", perAccount: true, cloud: true },
  "draft-outreach": { label: "Draft outreach", local: "batch", perAccount: true, cloud: true },
  refresh: { label: "Refresh (news + expired facts)", local: "session", perAccount: false, cloud: true },
  audit: { label: "Audit the knowledge base", local: "session", perAccount: false, cloud: true },
  learn: { label: "Teach a lesson", local: "session", perAccount: false, cloud: false },
};

export interface StartOptions { where: "local" | "cloud"; skill: string; icp?: string; domains?: string[]; args?: string; budget: number; by: string }
export interface Job {
  id: string; where: "local" | "cloud"; skill: string; icp?: string; domains?: string[]; args?: string; budget: number; by: string;
  status: "running" | "done" | "failed" | "question" | "interrupted"; started: string; finished?: string;
  summary?: string; cost?: number | null; session_id?: string; pr?: string | null; checks?: string[]; lines: string[];
}
type CloudRun = (o: { pluginRoot: string; repo: string; baseBranch: string; skill: string; args: string; capUsd: number; approvedBy: string }, log: (l: string) => void) => Promise<{ session_id: string; status: string; message: string; checks: string[]; cost_usd: number | null; pr: string | null }>;

export interface RunDeps { batch?: typeof runBatch; session?: ChunkRunner; cloud?: CloudRun; repo?: () => { repo: string; base: string } }

export class Runs {
  private jobs = new Map<string, Job>();
  private watchers = new Map<string, Set<(e: { line?: string; job?: Job }) => void>>();
  constructor(private ws: string, private pluginRoot: string, private deps: RunDeps = {}) {
    // history from earlier sessions of the app; a run that was going when the app stopped is marked interrupted
    const f = this.file();
    if (existsSync(f)) {
      for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
        try {
          const j = JSON.parse(l) as Job;
          this.jobs.set(j.id, { ...j, lines: [], status: j.status === "running" ? "interrupted" : j.status });
        } catch { /* skip a torn line */ }
      }
    }
  }
  private file() { return join(this.ws, ".ase", "app-runs.jsonl"); }
  private save(j: Job) {
    mkdirSync(dirname(this.file()), { recursive: true });
    const { lines: _lines, ...rest } = j;
    appendFileSync(this.file(), `${JSON.stringify(rest)}\n`);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.started.localeCompare(a.started)).map((j) => ({ ...j, lines: [] }));
  }
  get(id: string) { return this.jobs.get(id); }
  localBusy() { return [...this.jobs.values()].find((j) => j.where === "local" && j.status === "running") ?? null; }

  /** What a run would do before it starts: chunks and accounts for per-account stages, else one session. */
  async plan(o: StartOptions) {
    const spec = SKILLS[o.skill];
    if (!spec) throw new Error(`not a skill the app can run: ${o.skill}`);
    if (o.where === "cloud") return { where: "cloud", skill: o.skill, budget: o.budget, note: "Runs on Managed Agents (API credits); results come back as a pull request to review here." };
    if (spec.local === "batch") {
      if (!o.icp) throw new Error("pick an ICP");
      const p = await (this.deps.batch ?? runBatch)({ ws: this.ws, skill: o.skill as BatchSkill, icp: o.icp, pluginRoot: this.pluginRoot, budgetUsd: o.budget, domains: o.domains?.length ? o.domains : undefined, dryRun: true, log: () => {} });
      return { where: "local", skill: o.skill, accounts: p.accounts, chunks: p.chunks, model: p.model, billing: p.claude_billing, budget: o.budget };
    }
    return { where: "local", skill: o.skill, accounts: null, chunks: 1, billing: claudeBilling(), budget: o.budget };
  }

  start(o: StartOptions): Job {
    const spec = SKILLS[o.skill];
    if (!spec) throw new Error(`not a skill the app can run: ${o.skill}`);
    if (o.where === "cloud" && !spec.cloud) throw new Error(`${o.skill} only runs here`);
    if (!(o.budget > 0)) throw new Error("set a budget");
    if (o.where === "local") {
      const busy = this.localBusy();
      if (busy) throw new Error(`a local run is already going (${busy.skill}); wait for it or run this one in the cloud`);
    }
    const job: Job = { id: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, where: o.where, skill: o.skill, icp: o.icp, domains: o.domains, args: o.args, budget: o.budget, by: o.by, status: "running", started: new Date().toISOString(), lines: [] };
    this.jobs.set(job.id, job);
    const log = (line: string) => this.line(job, line);
    log(`${o.where === "local" ? "On this Mac" : "In the cloud"}: ${spec.label}${o.icp ? ` · ${o.icp}` : ""}${o.domains?.length ? ` · ${o.domains.join(", ")}` : ""} · budget $${o.budget}`);
    this.execute(job, spec, log).then(
      (r) => this.finish(job, r),
      (e) => this.finish(job, { status: "failed", summary: (e as Error).message }),
    );
    return job;
  }

  private async execute(job: Job, spec: (typeof SKILLS)[string], log: (l: string) => void): Promise<Partial<Job>> {
    const icpArg = job.icp ? ` --icp ${job.icp}` : "";
    const extra = [job.args ?? "", ...(job.domains ?? [])].filter(Boolean).join(" ");
    if (job.where === "cloud") {
      const cloud = this.deps.cloud ?? (await import("../managed/platform.ts")).run;
      const { repo, base } = (this.deps.repo ?? (() => workspaceRepo(this.ws)))();
      const r = await cloud({ pluginRoot: this.pluginRoot, repo, baseBranch: base, skill: job.skill, args: `${icpArg} ${extra}`.trim(), capUsd: job.budget, approvedBy: job.by }, log);
      return { status: r.status === "done" ? "done" : r.status === "question" ? "question" : "failed", summary: r.message, cost: r.cost_usd, session_id: r.session_id, pr: r.pr, checks: r.checks };
    }
    if (spec.local === "batch") {
      const r = await (this.deps.batch ?? runBatch)({ ws: this.ws, skill: job.skill as BatchSkill, icp: job.icp!, pluginRoot: this.pluginRoot, budgetUsd: job.budget, domains: job.domains?.length ? job.domains : undefined, log });
      const summary = `${r.advanced} of ${r.processed} accounts moved on${r.not_advanced.length ? ` (not: ${r.not_advanced.join(", ")})` : ""}${r.stopped ? ` · stopped: ${r.stopped}` : ""}`;
      return { status: r.stopped && !r.advanced ? "failed" : "done", summary, cost: r.spent_usd };
    }
    // one headless session in the workspace, on your subscription
    const runner = this.deps.session ?? defaultRunner();
    const prompt = `/agentic-sales-engine:${job.skill}${icpArg} --unattended ${extra}\n\n${UNATTENDED_NOTE(this.pluginRoot)}`;
    log("session started; it reports when done");
    const r = await runner({ ws: this.ws, prompt, model: "sonnet", maxBudgetUsd: job.budget, pluginRoot: this.pluginRoot });
    appendLedger(this.ws, { run_id: null, provider: "anthropic", op: `app:${job.skill}`, usd: r.cost_usd, kind: "actual", note: job.id, ...(claudeBilling() === "api" ? {} : { billed: false }) });
    await reindexAll(this.ws);
    return { status: r.ok ? "done" : "failed", summary: r.summary, cost: r.cost_usd };
  }

  private line(job: Job, line: string) {
    const stamped = `${new Date().toTimeString().slice(0, 8)}  ${line}`;
    job.lines.push(stamped);
    if (job.lines.length > 2000) job.lines.shift();
    for (const w of this.watchers.get(job.id) ?? []) w({ line: stamped });
  }
  private finish(job: Job, r: Partial<Job>) {
    Object.assign(job, r, { finished: new Date().toISOString() });
    this.line(job, `${job.status}${job.summary ? `: ${job.summary.split("\n")[0]}` : ""}`);
    this.save(job);
    for (const w of this.watchers.get(job.id) ?? []) w({ job: { ...job, lines: [] } });
  }

  /** Live lines of a job: everything so far, then new lines as they come, then the finished job. */
  stream(id: string): Response {
    const job = this.jobs.get(id);
    if (!job) return new Response("no such run", { status: 404 });
    const enc = new TextEncoder();
    let unsub = () => {};
    let ping: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream({
      start: (ctl) => {
        const send = (event: string, data: unknown) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        for (const l of job.lines) send("line", l);
        if (job.status !== "running") { send("end", { ...job, lines: [] }); ctl.close(); return; }
        const w = (e: { line?: string; job?: Job }) => {
          if (e.line) send("line", e.line);
          if (e.job) { send("end", e.job); cleanup(); ctl.close(); }
        };
        const set = this.watchers.get(id) ?? new Set();
        set.add(w);
        this.watchers.set(id, set);
        ping = setInterval(() => ctl.enqueue(enc.encode(": keep-alive\n\n")), 20_000);
        const cleanup = () => { set.delete(w); clearInterval(ping); };
        unsub = cleanup;
      },
      cancel: () => unsub(),
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
  }
}

/** The workspace's GitHub repo and branch, for cloud runs (they mount the repo and open a pull request on it). */
export function workspaceRepo(ws: string): { repo: string; base: string } {
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", ws, ...args]).stdout.toString().trim();
  const url = git(["remote", "get-url", "origin"]);
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error("this workspace has no GitHub remote, so it can't run in the cloud");
  return { repo: m[1]!, base: git(["rev-parse", "--abbrev-ref", "HEAD"]) || "main" };
}

export const isBatchSkill = (s: string): s is BatchSkill => s in BATCH_SKILLS;
