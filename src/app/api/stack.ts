import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeBilling } from "../../core/billing.ts";
import { credentialsFileMode, credentialsPath, keyStatus } from "../../core/credentials.ts";
import { providerKeys, tier } from "../../core/doctor.ts";
import { readLedger } from "../../core/ledger.ts";
import { paths } from "../../core/workspace.ts";
import { BACKENDS } from "../../observability/backends.ts";

/**
 * Where everything lives and runs, from local state only (no network on load): versions, which keys are set (never
 * their values), when each service was last used, and what's configured on the platform. Live checks are on demand.
 */

const ROOT = join(import.meta.dir, "../../..");
const git = (dir: string, args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};
const repoName = (url: string | null) => (url ? /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)?.[1] ?? url : null);
const countFiles = (dir: string, re: RegExp): number => {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name), re) : re.test(e.name) ? 1 : 0;
  return n;
};
const newest = (dir: string, re: RegExp) => {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => re.test(f)).map((f) => ({ f, t: statSync(join(dir, f)).mtime.toISOString() })).sort((a, b) => b.t.localeCompare(a.t));
  return files[0] ?? null;
};

export async function stack(ws: string | undefined) {
  const keys = keyStatus();
  const ledger = ws ? readLedger(ws) : [];
  const lastUse = (provider: string) => ledger.filter((e) => e.provider === provider).at(-1)?.ts ?? null;
  const spend30 = (provider: string) => Math.round(ledger.filter((e) => e.provider === provider && Date.parse(e.ts) > Date.now() - 30 * 86_400_000 && e.billed !== false).reduce((a, e) => a + e.usd, 0) * 100) / 100;
  const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8")) as { version: string };
  const statePath = join(credentialsPath(), "..", "managed.json");
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { environment_id?: string; vault_id?: string; agents?: Record<string, { version: number }>; skills?: Record<string, unknown>; deployments?: Record<string, string>; telemetry_destination_id?: string }) : null;
  const ghAuth = Bun.spawnSync(["gh", "auth", "status"]).exitCode === 0;
  const pk = providerKeys();
  const db = ws ? paths.db(ws) : null;
  const evals = ws ? newest(join(ws, "evals"), /\.json$/) : null;
  const bench = newest(join(ROOT, "bench/results"), /\.json$/);
  const set = (k: string) => keys[k]?.set ?? false;

  return {
    places: [
      {
        id: "mac", name: "Your Mac", note: "Where you work: Claude Code, the engine, this app, and your workspace.",
        items: [
          { id: "plugin", name: "Sales engine plugin", role: "17 skills, 4 agents, hooks and the provider gateway, inside Claude Code", status: "ok", facts: { version: plugin.version, commit: git(ROOT, ["rev-parse", "--short", "HEAD"]), "uncommitted changes": git(ROOT, ["status", "--porcelain"]) ? "yes" : "no", path: ROOT }, where: ROOT },
          { id: "cli", name: "ase command line", role: "Every engine action: apply, gates, scores, drafts, outcomes, ledger", status: "ok", facts: { run: "bun src/cli/ase.ts <command>" }, where: `${ROOT}/src/cli/ase.ts` },
          { id: "runner", name: "Batch runner", role: "Runs steps here as headless Claude sessions", status: "ok", facts: { "Claude billing": claudeBilling() === "subscription" ? "your subscription" : "per token (API)" }, where: `${ROOT}/src/core/batch.ts` },
          { id: "app", name: "This app", role: "Today, accounts, gates, runs, outcomes, and these system pages", status: "ok", facts: { address: "127.0.0.1 only" }, where: `${ROOT}/src/app` },
          { id: "workspace", name: "Your workspace", role: "Every account, brief, score, draft and outcome, as files in git", status: ws ? "ok" : "off", facts: ws ? { path: ws, repo: repoName(git(ws, ["remote", "get-url", "origin"])), branch: git(ws, ["rev-parse", "--abbrev-ref", "HEAD"]), accounts: countFiles(join(ws, "accounts"), /^company\.md$/), "raw snapshots": countFiles(join(ws, "raw"), /\.md$/), "search index": db && existsSync(db) ? `${Math.round(statSync(db).size / 1024)} KB` : "not built", "last eval": evals ? evals.t.slice(0, 10) : "none" } : {}, where: ws ?? "" },
          { id: "secrets", name: "Credentials file", role: "API keys for providers, tracing and Managed Agents; never in the workspace", status: existsSync(credentialsPath()) ? "ok" : "off", facts: { path: credentialsPath(), permissions: credentialsFileMode() ?? "missing", "keys set": Object.values(keys).filter((k) => k.set).length }, where: credentialsPath() },
        ],
      },
      {
        id: "github", name: "GitHub", note: "Where the engine and your workspace are kept, and where cloud runs send their results.",
        items: [
          { id: "engine-repo", name: "Engine repo", role: "The plugin's code; cloud runs check out the exact commit", status: "ok", facts: { repo: repoName(git(ROOT, ["remote", "get-url", "origin"])), branch: git(ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]) }, where: "github.com" },
          { id: "workspace-repo", name: "Workspace repo", role: "Your data; cloud runs push a branch and open a pull request here", status: ws && git(ws, ["remote", "get-url", "origin"]) ? "ok" : "off", facts: { repo: ws ? repoName(git(ws, ["remote", "get-url", "origin"])) : null, "token for cloud runs": set("ASE_MANAGED_AGENTS_GITHUB_TOKEN") ? "set" : "missing", "gh login (merging)": ghAuth ? "yes" : "no" }, where: "github.com" },
        ],
      },
      {
        id: "anthropic", name: "Anthropic", note: "Claude itself: your Max plan for work on this Mac, API credits for the cloud.",
        items: [
          { id: "subscription", name: "Claude subscription", role: "Pays for runs on this Mac (Claude Code and the batch runner)", status: claudeBilling() === "subscription" ? "ok" : "warn", facts: { billing: claudeBilling() }, where: "claude.ai" },
          { id: "managed", name: "Managed Agents", role: "Cloud runs and schedules: environment, key vault, 5 agents, 17 skills", status: state?.environment_id && set("ASE_MANAGED_AGENTS_API_KEY") ? "ok" : "off", facts: state ? { "API key": set("ASE_MANAGED_AGENTS_API_KEY") ? keys.ASE_MANAGED_AGENTS_API_KEY!.value : "missing", environment: state.environment_id ?? "–", vault: state.vault_id ?? "–", agents: Object.keys(state.agents ?? {}).length, skills: Object.keys(state.skills ?? {}).length, schedules: Object.keys(state.deployments ?? {}).length, "traces to Braintrust": state.telemetry_destination_id ? "on" : "off" } : { setup: "not synced yet: bun src/managed/cli.ts sync" }, where: "platform.claude.com" },
        ],
      },
      {
        id: "providers", name: "Data providers", note: `Paid lookups, all through the engine's gateway (budgets, ledger, saved pages). ${tier().detail}.`,
        items: [
          { id: "exa", name: "Exa", role: "Company search, people, news, deep research", status: pk.exa ? "ok" : "off", facts: { key: set("EXA_API_KEY") ? keys.EXA_API_KEY!.value : pk.exa ? "set in Claude Code" : "missing", "last used": lastUse("exa"), "spent, 30 days": `$${spend30("exa")}` }, where: "api.exa.ai" },
          { id: "firecrawl", name: "Firecrawl", role: "Reading company pages, structured extraction", status: pk.firecrawl ? "ok" : "off", facts: { key: set("FIRECRAWL_API_KEY") ? keys.FIRECRAWL_API_KEY!.value : pk.firecrawl ? "set in Claude Code" : "missing", "last used": lastUse("firecrawl"), "spent, 30 days": `$${spend30("firecrawl")}` }, where: "api.firecrawl.dev" },
        ],
      },
      {
        id: "observability", name: "Tracing & evals", note: "Every run's trace and the bench's quality scores, side by side in three tools.",
        items: BACKENDS.map((b) => ({ id: b.id, name: b.label, role: b.id === "braintrust" ? "Traces, experiments, and the Managed Agents' own traces" : "Traces of every run and eval scores", status: b.configured(process.env) ? "ok" : "off", facts: { configured: b.configured(process.env) ? "yes" : "no" }, where: b.id, check: b.configured(process.env) })),
      },
    ],
    bench: bench ? { label: bench.f.replace(/\.json$/, ""), at: bench.t.slice(0, 10) } : null,
  };
}

/** A live check of one tracing backend, on request. */
export async function check(name: string) {
  const b = BACKENDS.find((x) => x.id === name);
  if (!b) throw new Error(`no backend ${name}`);
  if (!b.configured(process.env)) return { ok: false, detail: "not configured" };
  return b.verify(process.env);
}
