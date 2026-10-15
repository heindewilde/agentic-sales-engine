#!/usr/bin/env bun
/**
 * `ase` — deterministic helpers the skills call via Bash:
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts <command> [args]
 * Every command prints JSON (or --text for humans) so skills can parse results reliably.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { parseArgs } from "node:util";
import { CONTRACTS, checkAccount } from "../core/contracts.ts";
import { reindexAll } from "../core/db.ts";
import { formatBrief, health } from "../core/doctor.ts";
import { forgetPerson } from "../core/forget.ts";
import { parseYaml, readDoc, stringifyYaml } from "../core/frontmatter.ts";
import { appendLedger, currentRun, newRunId, readLedger, spentForRun, spentToday, sumSpend } from "../core/ledger.ts";
import { lint } from "../core/lint.ts";
import { normalizeDomain, normalizeLinkedIn } from "../core/normalize.ts";
import { DncEntry, type Company } from "../core/schemas.ts";
import { dncMatcher, loadConfig, loadDnc, paths, relPath, requireWorkspace, today } from "../core/workspace.ts";
import { validateContent } from "../core/validate.ts";

const [cmd, ...rest] = process.argv.slice(2);
const { values: flags, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    text: { type: "boolean" },
    stage: { type: "string" },
    icp: { type: "string" },
    budget: { type: "string" },
    "approved-by": { type: "string" },
    reason: { type: "string" },
    note: { type: "string" },
    days: { type: "string" },
    dnc: { type: "boolean" },
    workspace: { type: "string" },
    name: { type: "string" },
    website: { type: "string" },
    member: { type: "string", multiple: true },
  },
});

const out = (data: unknown, text?: string) => {
  process.stdout.write(flags.text && text !== undefined ? `${text}\n` : `${JSON.stringify(data, null, 2)}\n`);
};
const fail = (msg: string, code = 1): never => {
  process.stderr.write(`ase: ${msg}\n`);
  process.exit(code);
};

const HELP = `ase <command>
  init <dir> [--name N] [--website URL] [--member id:Name ...]   scaffold a new workspace
  doctor [--text]                         workspace health: tier, budget, funnel, gates, problems
  reindex                                 rebuild the SQLite index from files
  validate <file...>                      validate files against workspace schemas
  validate --stage <s> --icp <slug>       check stage handoff contracts for all accounts at/after stage
  lint [--text]                           mechanical KB lint (invalid, stale, orphans, duplicates, contracts)
  dnc list | add <kind> <value> --reason <r> [--note] | remove <value> | check <value>
  forget-person <person-id> [--dnc]       GDPR erasure; prints remaining prose mentions to redact
  ledger run start --stage <s> [--icp] --budget <usd> [--approved-by <m>]
  ledger run extend --budget <usd> --approved-by <m>
  ledger run end
  ledger record <provider> <op> <usd> [--note]
  ledger report [--days N]
  contracts                               list stage contracts`;

const ws = () => requireWorkspace(flags.workspace as string | undefined);

switch (cmd) {
  case "init": {
    const target = resolve(positionals[0] ?? ".");
    if (existsSync(join(target, "ase.config.yaml"))) fail(`${target} is already a workspace`);
    const tpl = join(import.meta.dir, "..", "..", "workspace-template");
    mkdirSync(target, { recursive: true });
    cpSync(tpl, target, { recursive: true, force: false, errorOnExist: false });
    const cfgPath = join(target, "ase.config.yaml");
    const doc = YAML.parseDocument(readFileSync(cfgPath, "utf8"));
    if (flags.name) doc.setIn(["workspace", "name"], flags.name);
    if (flags.website) doc.setIn(["workspace", "website"], flags.website);
    const members = (flags.member as string[] | undefined) ?? [];
    if (members.length) {
      doc.set("members", members.map((m) => {
        const [id, ...name] = m.split(":");
        return { id: (id ?? "").toLowerCase(), name: name.join(":") || id };
      }));
    }
    writeFileSync(cfgPath, doc.toString());
    const cfg = await loadConfig(target);
    if (!existsSync(join(target, ".git"))) Bun.spawnSync(["git", "init", "-q"], { cwd: target });
    await reindexAll(target);
    out({ workspace: target, config: cfg });
    break;
  }
  case "doctor": {
    const h = await health(ws());
    out(h, formatBrief(h));
    break;
  }
  case "reindex": {
    const w = ws();
    const ttl = (await loadConfig(w).catch(() => null))?.ttl_days.default ?? 120;
    out(await reindexAll(w, ttl));
    break;
  }
  case "validate": {
    const w = ws();
    if (flags.stage) {
      const icp = (flags.icp as string) ?? fail("--icp is required with --stage");
      const results: Record<string, string[]> = {};
      const dir = `${w}/accounts`;
      for (const domain of existsSync(dir) ? readdirSync(dir) : []) {
        const p = paths.company(w, domain);
        if (!existsSync(p)) continue;
        const { data } = await readDoc<Company>(p);
        const errs = await checkAccount(w, domain, icp, data);
        if (errs.length) results[domain] = errs;
      }
      out({ ok: Object.keys(results).length === 0, failures: results });
      if (Object.keys(results).length) process.exitCode = 2;
      break;
    }
    const cfg = await loadConfig(w).catch(() => null);
    const dnc = dncMatcher(await loadDnc(w));
    const results: Record<string, string[]> = {};
    for (const f of positionals) {
      const rel = relPath(w, f) ?? fail(`${f} is outside the workspace`);
      results[rel] = validateContent(rel, readFileSync(`${w}/${rel}`, "utf8"), { privacyMode: cfg?.privacy_mode ?? true, dnc, exists: true });
    }
    const ok = Object.values(results).every((e) => e.length === 0);
    out({ ok, results });
    if (!ok) process.exitCode = 2;
    break;
  }
  case "lint": {
    const issues = await lint(ws());
    const byKind = issues.reduce<Record<string, number>>((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});
    out({ count: issues.length, byKind, issues }, issues.length ? issues.map((i) => `[${i.kind}] ${i.path}: ${i.detail}`).join("\n") : "No issues.");
    break;
  }
  case "contracts":
    out(CONTRACTS.map((c) => ({ stage: c.stage, requires: c.description })));
    break;
  case "dnc": {
    const w = ws();
    const f = paths.dnc(w);
    const doc = (existsSync(f) ? parseYaml<{ entries?: unknown[] }>(readFileSync(f, "utf8")) : null) ?? { entries: [] };
    doc.entries ??= [];
    const [sub, a, b] = positionals;
    if (sub === "list" || !sub) out(doc);
    else if (sub === "add") {
      const kind = a as "domain" | "email" | "linkedin";
      const raw = b ?? fail("usage: dnc add <domain|email|linkedin> <value> --reason <reason>");
      const value = kind === "domain" ? normalizeDomain(raw) : kind === "linkedin" ? normalizeLinkedIn(raw) : raw.trim().toLowerCase();
      const entry = DncEntry.parse({ kind, value: value ?? fail(`cannot normalize ${raw}`), reason: flags.reason ?? "other", note: flags.note, added: today() });
      doc.entries.push(entry);
      writeFileSync(f, stringifyYaml(doc));
      out({ added: entry });
    } else if (sub === "remove") {
      const before = doc.entries.length;
      doc.entries = doc.entries.filter((e) => (e as { value: string }).value !== a);
      writeFileSync(f, stringifyYaml(doc));
      out({ removed: before - doc.entries.length });
    } else if (sub === "check") {
      const m = dncMatcher(await loadDnc(w));
      const v = a ?? fail("usage: dnc check <value>");
      out({ value: v, blocked: m.domain(v) || m.email(v) || m.linkedin(v) });
    } else fail(`unknown dnc subcommand ${sub}`);
    break;
  }
  case "forget-person": {
    const id = positionals[0] ?? fail("usage: forget-person <person-id> [--dnc]");
    const w = ws();
    const r = await forgetPerson(w, id, { addDnc: Boolean(flags.dnc) });
    await reindexAll(w);
    out(r);
    break;
  }
  case "ledger": {
    const w = ws();
    const [sub, sub2] = positionals;
    const runFile = paths.currentRun(w);
    if (sub === "run" && sub2 === "start") {
      const cfg = await loadConfig(w).catch(() => null);
      const budget = Number(flags.budget ?? cfg?.budgets.per_run_usd ?? process.env.ASE_DEFAULT_RUN_BUDGET_USD ?? 5);
      if (!(budget > 0)) fail("--budget must be a positive number");
      const stage = (flags.stage as string) ?? fail("--stage is required");
      const run = { run_id: newRunId(stage), stage, icp: flags.icp, budget_usd: budget, started: new Date().toISOString(), approved_by: flags["approved-by"] };
      mkdirSync(dirname(runFile), { recursive: true });
      writeFileSync(runFile, JSON.stringify(run, null, 2));
      out(run);
    } else if (sub === "run" && sub2 === "extend") {
      const run = currentRun(w) ?? fail("no active run");
      if (!flags["approved-by"]) fail("--approved-by is required: extending a budget is a human decision");
      run.budget_usd = Number(flags.budget ?? fail("--budget is required"));
      run.approved_by = flags["approved-by"] as string;
      writeFileSync(runFile, JSON.stringify(run, null, 2));
      out(run);
    } else if (sub === "run" && sub2 === "end") {
      const run = currentRun(w);
      if (existsSync(runFile)) rmSync(runFile);
      out(run ? { ...run, spent_usd: spentForRun(w, run.run_id), ended: new Date().toISOString() } : { ended: null });
    } else if (sub === "record") {
      appendLedger(w, { run_id: currentRun(w)?.run_id ?? null, provider: (positionals[1] as "other") ?? "other", op: positionals[2] ?? "manual", usd: Number(positionals[3] ?? 0), kind: "actual", note: flags.note as string | undefined });
      out({ ok: true });
    } else if (sub === "report") {
      const days = Number(flags.days ?? 30);
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const entries = readLedger(w).filter((e) => e.ts >= since);
      const byProvider: Record<string, number> = {};
      const byRun: Record<string, number> = {};
      for (const e of entries) {
        byProvider[e.provider] = sumSpend(entries.filter((x) => x.provider === e.provider));
        byRun[e.run_id ?? "(none)"] = sumSpend(entries.filter((x) => (x.run_id ?? "(none)") === (e.run_id ?? "(none)")));
      }
      out({ days, total_usd: sumSpend(entries), today_usd: spentToday(w), byProvider, byRun, active_run: currentRun(w) });
    } else fail("usage: ledger run start|extend|end, ledger record, ledger report");
    break;
  }
  case undefined:
  case "help":
  case "--help":
    process.stdout.write(`${HELP}\n`);
    break;
  default:
    fail(`unknown command "${cmd}"\n\n${HELP}`);
}
