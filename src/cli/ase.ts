#!/usr/bin/env bun
/**
 * `ase` — deterministic helpers the skills call via Bash:
 *   bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts <command> [args]
 * Every command prints JSON (or --text for humans) so skills can parse results reliably.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { parseArgs } from "node:util";
import { CONTRACTS, checkAccount } from "../core/contracts.ts";
import { reindexAll } from "../core/db.ts";
import { formatBrief, health, tier } from "../core/doctor.ts";
import { forgetPerson } from "../core/forget.ts";
import { parseYaml, readDoc, stringifyYaml } from "../core/frontmatter.ts";
import { claudeBilling } from "../core/billing.ts";
import { appendLedger, currentRun, newRunId, readLedger, spentForRun, spentToday, subscriptionUsage, sumSpend } from "../core/ledger.ts";
import { lint } from "../core/lint.ts";
import { normalizeDomain, normalizeLinkedIn } from "../core/normalize.ts";
import { DncEntry, Stage, type Company } from "../core/schemas.ts";
import { KEYS, credentialsFileMode, credentialsPath, loadCredentials, mask, parseEnv, removeCredentials, saveCredential } from "../core/credentials.ts";
import { advanceStage, staleFacts, waysIn } from "../core/waysin.ts";
import { addWatch, estimateSync, loadWatchlist, removeWatch, runSync } from "../core/watch.ts";
import { accountStates, logEvent, migrateLegacy, openItems, outcomeStats, readEvents, winLossCases, type EventType, type OutcomeEvent } from "../core/outcomes.ts";
import { runOffline } from "../evals/offline.ts";
import { BACKENDS, connectedBackends } from "../observability/backends.ts";
import { buildDataset } from "../observability/datasets.ts";
import { tracesUrl } from "../core/tracing.ts";
import { buildContext } from "../core/context.ts";
import { applyUpdates, readApplyFile } from "../core/apply.ts";
import { initTracing, setAttrs, shutdownTracing, withSpan } from "../core/tracing.ts";
import { runLlm } from "../evals/llm.ts";
import { compare, formatReport, latestResult, saveResult } from "../evals/report.ts";
import { listDrafts, markDraft, markLearned, pendingEdits, snapshotOriginal } from "../core/drafts.ts";
import { dncMatcher, findWorkspace, loadConfig, loadDnc, paths, relPath, requireWorkspace, today } from "../core/workspace.ts";
import { validateContent } from "../core/validate.ts";
import { callProvider, estimateCall } from "../core/providers/gateway.ts";
import { persistCandidates } from "../core/accounts.ts";
import { importConnections, readSeedCsv, rematchAll } from "../core/importers.ts";
import { approveShortlist, proposeShortlist } from "../core/shortlist.ts";
import { archiveScoring, rank, recomputeAll, runBacktest, runRecalibrate, runSensitivity, writeScore } from "../core/scorefile.ts";
import { OPS, ProviderError, type Op, type ProviderName } from "../core/providers/types.ts";

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
    input: { type: "string" },
    provider: { type: "string" },
    estimate: { type: "boolean" },
    account: { type: "string" },
    calibration: { type: "string" },
    label: { type: "string" },
    mode: { type: "string" },
    judgements: { type: "string" },
    limit: { type: "string" },
    map: { type: "string", multiple: true },
    run: { type: "string" },
    pct: { type: "string" },
    max: { type: "string" },
    file: { type: "string" },
    to: { type: "string" },
    suite: { type: "string" },
    sample: { type: "string" },
    model: { type: "string" },
    "no-save": { type: "boolean" },
    min: { type: "string" },
    push: { type: "boolean" },
    experiment: { type: "string" },
    host: { type: "string" },
    endpoint: { type: "string" },
    "api-url": { type: "string" },
    project: { type: "string" },
    page: { type: "string", multiple: true },
    query: { type: "string" },
    status: { type: "string" },
    since: { type: "string" },
    person: { type: "string" },
    channel: { type: "string" },
    value: { type: "string" },
    date: { type: "string" },
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
  provider <op> --input '<json>' [--provider exa|firecrawl] [--estimate]
                                          call a provider op through the gateway (keys from EXA_API_KEY /
                                          FIRECRAWL_API_KEY env; ASE_PROVIDER_MODE=record|replay for cassettes)
  score compute --icp <s> --account <domain> --mode light|full [--judgements <file>|stdin]
  score compute --icp <s> --calibration <domain> --label good|bad --mode full [--judgements ...]
  score backtest --icp <s> [--mode light|full]     rank known good vs bad customers (AUC, percentile)
  score sensitivity --icp <s> [--mode ...]        weight ±20% / drop-one stability per factor
  score rank --icp <s> [--stage <stage>] [--limit N]
  score recalibrate --icp <s>                      propose weights from logged outcomes (never applied)
  score recompute --icp <s>                        re-score all files from stored judgements (after weight edits)
  score reconcile --icp <s> [--account d | --stage s] [--limit N]   second opinion on full scores (judge twice, a third settles)
  scoring archive --icp <s>                        snapshot scoring.yaml to scoring.history/ before editing
  outcome log <domain> <event> --icp <s> [--person id] [--channel c] [--reason r] [--value eur] [--member m] [--note "…"] [--date YYYY-MM-DD]
        events: sent replied_positive replied_neutral replied_negative unsubscribed meeting_booked meeting_held
                opportunity won lost disqualified no_response   (reason required for replied_negative|lost|disqualified)
        reasons: timing no_budget competitor no_pain wrong_person not_icp internal_build status_quo opted_out other
  outcomes open [--icp <s>]               accounts needing a status update (weekly review input), most urgent first
  outcomes state <domain> [--icp <s>]     derived state + event history for one account
  outcomes stats --icp <s>                engagement by tier, trigger and channel (95% intervals), loss reasons, readiness
  outcomes cases --icp <s> [--since YYYY-MM-DD]   resolved accounts joined to scores, notes and briefs (win-loss input)
  outcomes migrate                        convert a legacy outcomes.csv into the event log
  import seeds <file.csv> --icp <s> [--map field=Column ...] [--run <id>]   add a seed list as candidates
  import connections <Connections.csv> --member <id>   LinkedIn export → local copy + warm-matches.yaml
  connections match                       recompute every member's warm matches (after discovery)
  accounts --icp <s> [--stage <stage>]    list account domains for an ICP (optionally at one stage)
  shortlist propose --icp <s> [--pct N] [--max N]     GATE 2 proposal with cost estimate
  shortlist approve --icp <s> --file <lists/.../shortlist.md> --approved-by <member>
  stage advance <domain> --icp <s> --to <stage> [--reason ...]   move forward only if the contract holds
  ways-in <domain> --icp <s>              warm paths, recent signals, people/personas for an account
  ttl [--icp <s>] [--limit N]             facts past their TTL, most advanced accounts first
  watch add <domain> --icp <s> [--page <url> ...] [--query "<extra words>"]   monitor an account
  watch list | watch remove <domain> [--icp <s>]
  sync [--icp <s>] [--account <d>] [--estimate]   poll news + watched pages → sync/<date>.md for review
  drafts list [--status s] [--account d] | snapshot <file> | mark <file> <draft|edited|sent|discarded>
  drafts edits                            original vs human-final pairs not yet learned from
  drafts learned <file> [...]             mark edit pairs as absorbed into the voice profile
  eval run [--suite offline|llm] [--budget usd] [--sample n] [--model m] [--min 0.9] [--no-save] [--push [--experiment <label>]]
                                          quality evals: citation faithfulness, grounding, handoffs, draft rules (offline);
                                          claim support, judge stability, draft quality (llm, via Claude). Exit 3 on regression,
                                          exit 4 when an evaluator's mean is below --min.
  context <domain...> --icp <s> [--mode light|full]   compact JSON with everything a stage session needs
  apply <file.json>                       structured writes for a chunk of accounts (facts, brief sections, people,
                                          signals, judgements → score + stage), validated per account
  observability connect langfuse [--host https://cloud.langfuse.com|https://us.cloud.langfuse.com|<self-hosted>]
                                          reads "public_key:secret_key" from stdin; enables traces, eval scores, datasets
  observability connect langsmith [--endpoint <url>] [--project <name>]   reads the API key from stdin
  observability connect braintrust [--api-url https://api-eu.braintrust.dev] [--project <name>]   API key from stdin
  observability status | disconnect <langfuse|langsmith|braintrust>
                                          (or put the keys in ~/.config/agentic-sales-engine/credentials.env yourself)
  dataset push --icp <s> [--mode full|light] [--name <dataset>]   accounts as input/expected pairs → connected backends
  keys status                             which provider keys the CLI/batch will use (masked) and from where
  keys set <EXA_API_KEY|FIRECRAWL_API_KEY|FIRECRAWL_BASE_URL>   read the value from stdin (e.g. pbpaste | …)
  keys pull-firecrawl                     import the key from the official Firecrawl CLI login
  contracts                               list stage contracts`;

const ws = () => requireWorkspace(flags.workspace as string | undefined);
initTracing("cli");
// Provider keys for CLI runs: env, workspace .env, then ~/.config/agentic-sales-engine/credentials.env.
const keyOrigin = loadCredentials(findWorkspace(flags.workspace as string | undefined));

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
  case "provider": {
    const op = positionals[0] as Op;
    if (!OPS.includes(op)) fail(`usage: provider <${OPS.join("|")}> --input '<json>'`);
    let input: unknown;
    try {
      input = JSON.parse((flags.input as string) ?? "{}");
    } catch {
      fail("--input must be valid JSON");
    }
    const opts = { ws: ws(), provider: flags.provider as ProviderName | undefined };
    try {
      out(flags.estimate ? await estimateCall(op, input, opts) : await callProvider(op, input, opts));
    } catch (e) {
      out({ error: (e as Error).message, code: e instanceof ProviderError ? e.code : "provider_failed" });
      process.exitCode = 3;
    }
    break;
  }
  case "score": {
    const w = ws();
    const sub = positionals[0];
    const icp = (flags.icp as string) ?? fail("--icp is required");
    const mode = ((flags.mode as string) ?? "full") as "light" | "full";
    if (mode !== "light" && mode !== "full") fail("--mode must be light or full");
    try {
      if (sub === "compute") {
        const src = flags.judgements as string | undefined;
        const text = src && src !== "-" ? readFileSync(resolve(src), "utf8") : await Bun.stdin.text();
        const judgements = JSON.parse(text);
        const label = flags.label as "good" | "bad" | undefined;
        if (flags.calibration && label !== "good" && label !== "bad") fail("--label good|bad is required with --calibration");
        const domain = (flags.calibration ?? flags.account) as string | undefined;
        out(await writeScore({ ws: w, icp, domain: domain ?? fail("--account or --calibration is required"), mode, judgements, calibration: flags.calibration ? label : undefined }));
      } else if (sub === "backtest") out(await runBacktest(w, icp, mode));
      else if (sub === "sensitivity") out(await runSensitivity(w, icp, mode));
      else if (sub === "rank") out(await rank(w, icp, { stage: flags.stage as string | undefined, limit: flags.limit ? Number(flags.limit) : undefined }));
      else if (sub === "recalibrate") out(await runRecalibrate(w, icp));
      else if (sub === "recompute") out(await recomputeAll(w, icp));
      else if (sub === "reconcile") {
        // second opinion on full scores: --account <d> or --stage <s> (default scored), --limit N
        const { reconcileAccount } = await import("../core/reconcile.ts");
        const { askOnce } = await import("../core/headless.ts");
        const cfg = await loadConfig(w);
        const billing = claudeBilling(cfg.claude_billing);
        const domains = flags.account ? [flags.account as string] : (await rank(w, icp, { stage: (flags.stage as string) ?? "scored" })).map((r) => r.domain).slice(0, flags.limit ? Number(flags.limit) : undefined);
        const results = [];
        for (const d of domains) {
          const r = await reconcileAccount(w, icp, d, { ask: askOnce(billing), model: cfg.judging.model });
          if (!r.skipped) appendLedger(w, { run_id: currentRun(w)?.run_id ?? null, provider: "anthropic", op: "reconcile", usd: r.cost_usd, kind: "actual", note: d, ...(billing === "api" ? {} : { billed: false }) });
          results.push(r);
        }
        out({ accounts: results.length, changed: results.reduce((n, r) => n + r.changed.length, 0), disputed: results.reduce((n, r) => n + r.disputed.length, 0), results });
      }
      else fail("usage: score compute|backtest|sensitivity|rank|recalibrate|recompute|reconcile --icp <slug>");
    } catch (e) {
      fail((e as Error).message, 2);
    }
    break;
  }
  case "scoring": {
    if (positionals[0] !== "archive") fail("usage: scoring archive --icp <slug>");
    try {
      out(await archiveScoring(ws(), (flags.icp as string) ?? fail("--icp is required")));
    } catch (e) {
      fail((e as Error).message, 2);
    }
    break;
  }
  case "import": {
    const w = ws();
    const kind = positionals[0];
    const file = positionals[1] ?? fail("usage: import seeds|connections <file>");
    if (!existsSync(resolve(file))) fail(`${file} not found`);
    try {
      if (kind === "seeds") {
        const icp = (flags.icp as string) ?? fail("--icp is required");
        const overrides = Object.fromEntries(((flags.map as string[] | undefined) ?? []).map((m) => m.split("=") as [string, string]));
        const src = resolve(file);
        // Keep a copy of the seed list in the workspace so import:<path> sources resolve for everyone.
        const dest = src.startsWith(w) ? src : join(w, "imports", "seeds", src.split("/").pop()!);
        if (dest !== src) cpSync(src, dest);
        const { candidates, columns, rows } = readSeedCsv(w, dest, overrides);
        const runId = (flags.run as string) ?? `${today()}-import`;
        const res = await persistCandidates(w, icp, runId, `import:${dest.slice(w.length + 1)}`, candidates);
        await rematchAll(w);
        out({ rows, columns, ...res, created: res.created.length, added_to_icp: res.added_to_icp.length, already_in_icp: res.already_in_icp.length, created_domains: res.created });
      } else if (kind === "connections") {
        const member = (flags.member as string[] | undefined)?.[0] ?? fail("--member is required");
        const cfg = await loadConfig(w);
        if (cfg.members.length && !cfg.members.some((m) => m.id === member)) fail(`"${member}" is not a member in ase.config.yaml`);
        out(await importConnections(w, member, resolve(file)));
      } else fail("usage: import seeds|connections <file>");
    } catch (e) {
      fail((e as Error).message, 2);
    }
    await reindexAll(w);
    break;
  }
  case "connections": {
    const w = ws();
    if (positionals[0] !== "match") fail("usage: connections match");
    const r = await rematchAll(w);
    await reindexAll(w);
    out(r);
    break;
  }
  case "accounts": {
    const w = ws();
    const icp = (flags.icp as string) ?? fail("--icp is required");
    const dir = join(w, "accounts");
    const res: { domain: string; stage: string; name: string }[] = [];
    for (const d of existsSync(dir) ? readdirSync(dir) : []) {
      const p = paths.company(w, d);
      if (!existsSync(p)) continue;
      const { data } = await readDoc<Company>(p);
      const st = data.icp_status?.[icp];
      if (st && (!flags.stage || st.stage === flags.stage)) res.push({ domain: d, stage: st.stage, name: data.name });
    }
    out(res, res.map((r) => `${r.domain}\t${r.stage}\t${r.name}`).join("\n"));
    break;
  }
  case "shortlist": {
    const w = ws();
    const icp = (flags.icp as string) ?? fail("--icp is required");
    try {
      if (positionals[0] === "propose") {
        const p = await proposeShortlist(w, icp, { pct: flags.pct ? Number(flags.pct) : undefined, max: flags.max ? Number(flags.max) : undefined });
        out({ ...p, picked: p.picked.map((x) => ({ domain: x.domain, name: x.name, total: x.total, upside: x.upside, coverage: x.coverage, tier: x.tier, why: x.why })) });
      } else if (positionals[0] === "approve") {
        const by = (flags["approved-by"] as string) ?? fail("--approved-by is required: GATE 2 is a human decision");
        out(await approveShortlist(w, icp, (flags.file as string) ?? fail("--file is required"), by));
      } else fail("usage: shortlist propose|approve --icp <slug>");
    } catch (e) {
      fail((e as Error).message, 2);
    }
    break;
  }
  case "stage": {
    const w = ws();
    const [sub, domainRaw] = positionals;
    if (sub !== "advance" || !domainRaw) fail("usage: stage advance <domain> --icp <slug> --to <stage>");
    const to = Stage.safeParse(flags.to);
    if (!to.success) fail(`--to must be one of ${Stage.options.join(", ")}`);
    try {
      const r = await advanceStage(w, normalizeDomain(domainRaw) ?? domainRaw!, (flags.icp as string) ?? fail("--icp is required"), to.data!, flags.reason as string | undefined);
      out(r);
      if (!r.advanced) process.exitCode = 2;
    } catch (e) {
      fail((e as Error).message, 2);
    }
    break;
  }
  case "ways-in": {
    const w = ws();
    const d = positionals[0] ?? fail("usage: ways-in <domain> --icp <slug>");
    out(await waysIn(w, normalizeDomain(d) ?? d, (flags.icp as string) ?? fail("--icp is required")));
    break;
  }
  case "ttl": {
    const w = ws();
    await reindexAll(w);
    out(await staleFacts(w, { icp: flags.icp as string | undefined, limit: flags.limit ? Number(flags.limit) : undefined }));
    break;
  }
  case "watch": {
    const w = ws();
    const [sub, d] = positionals;
    try {
      if (sub === "add") {
        const icp = (flags.icp as string) ?? fail("--icp is required");
        out(await addWatch(w, d ?? fail("usage: watch add <domain> --icp <slug>"), icp, { pages: flags.page as string[] | undefined, news_query: flags.query as string | undefined, by: (flags.member as string[] | undefined)?.[0] }));
      } else if (sub === "remove") out(removeWatch(w, normalizeDomain(d ?? "") ?? d ?? fail("usage: watch remove <domain>"), flags.icp as string | undefined));
      else {
        const wl = loadWatchlist(w);
        out({ entries: wl.entries.length, est_cost_per_sync_usd: estimateSync(wl), watchlist: wl.entries.map((e) => ({ account: e.account, icp: e.icp, news: e.news, pages: e.pages, last_news_check: e.last_news_check ?? null })) });
      }
    } catch (e) {
      fail((e as Error).message, 2);
    }
    break;
  }
  case "sync": {
    const w = ws();
    if (flags.estimate) {
      out({ est_usd: estimateSync(loadWatchlist(w), flags.icp as string | undefined) });
      break;
    }
    const r = await runSync(w, { icp: flags.icp as string | undefined, account: flags.account as string | undefined });
    await reindexAll(w);
    out({ ...r, items: r.items.map((i) => ({ kind: i.kind, account: i.account, title: i.title, url: i.url, published: i.published ?? null })) });
    break;
  }
  case "drafts": {
    const w = ws();
    const sub = positionals[0] ?? "list";
    try {
      if (sub === "list") out(await listDrafts(w, { status: flags.status as string | undefined, account: flags.account as string | undefined }));
      else if (sub === "snapshot") out(snapshotOriginal(w, relPath(w, positionals[1] ?? fail("usage: drafts snapshot <file>")) ?? fail("file outside workspace")));
      else if (sub === "mark") {
        const status = positionals[2] as "draft" | "edited" | "sent" | "discarded";
        if (!["draft", "edited", "sent", "discarded"].includes(status)) fail("usage: drafts mark <file> <draft|edited|sent|discarded>");
        out(await markDraft(w, relPath(w, positionals[1] ?? "") ?? fail("file outside workspace"), status, { member: (flags.member as string[] | undefined)?.[0], date: flags.date as string | undefined }));
      } else if (sub === "edits") out(await pendingEdits(w));
      else if (sub === "learned") out(await markLearned(w, positionals.slice(1).map((p) => relPath(w, p) ?? fail(`${p} outside workspace`))));
      else fail("usage: drafts list|snapshot|mark|edits|learned");
    } catch (e) {
      fail((e as Error).message, 2);
    }
    break;
  }
  case "context": {
    const w = ws();
    const mode = ((flags.mode as string) ?? "light") as "light" | "full";
    const domains = positionals.map((d) => normalizeDomain(d) ?? d);
    if (!domains.length) fail("usage: context <domain...> --icp <slug> [--mode light|full]");
    process.stdout.write(`${JSON.stringify(await buildContext(w, (flags.icp as string) ?? fail("--icp is required"), domains, mode))}\n`);
    break;
  }
  case "apply": {
    const w = ws();
    const file = positionals[0] ?? fail("usage: apply <file.json>  (or - for stdin)");
    const raw = file === "-" ? JSON.parse(await Bun.stdin.text()) : readApplyFile(resolve(file));
    try {
      const r = await applyUpdates(w, raw);
      out({ ...r, results: r.results.map((x) => ({ domain: x.domain, ok: x.ok, stage: x.stage, score: x.score, errors: x.errors })) });
      if (!r.ok) process.exitCode = 2;
    } catch (e) {
      fail(`invalid apply file: ${(e as Error).message.slice(0, 800)}`, 2);
    }
    break;
  }
  case "eval": {
    const w = ws();
    if (positionals[0] !== "run") fail("usage: eval run [--suite offline|llm] [--budget usd] [--sample n]");
    const suite = ((flags.suite as string) ?? "offline") as "offline" | "llm";
    if (suite !== "offline" && suite !== "llm") fail("--suite must be offline or llm");
    let evalTraceId: string | undefined;
    const r = await withSpan(`eval.${suite}`, { "ase.suite": suite, "ase.experiment": (flags.experiment as string) ?? null }, async (span) => {
      evalTraceId = span.spanContext().traceId;
      const res = suite === "offline"
        ? await runOffline(w)
        : await runLlm(w, { budgetUsd: flags.budget ? Number(flags.budget) : 1, sample: flags.sample ? Number(flags.sample) : 3, model: (flags.model as string) ?? "sonnet" });
      setAttrs(span, { "ase.cost_usd": res.cost_usd, ...Object.fromEntries(Object.entries(res.summary).map(([k, v]) => [`ase.eval.${k}`, v.mean])) });
      return res;
    });
    const saved = flags["no-save"] ? null : saveResult(w, r);
    const cmp = compare(r, latestResult(w, suite, saved ?? undefined));
    const pushed: Record<string, unknown> = {};
    if (flags.push) {
      const backends = connectedBackends();
      if (!backends.length) process.stderr.write("ase: --push: no observability backend connected (ase observability connect langfuse|langsmith|braintrust)\n");
      for (const b of backends) pushed[b.id] = await b.pushScores(process.env, r, { traceId: evalTraceId, experiment: flags.experiment as string | undefined }).catch((e) => ({ error: (e as Error).message }));
    }
    out({ saved, ...cmp, pushed, summary: r.summary, cost_usd: r.cost_usd, results: r.results }, `${formatReport(r, cmp)}${Object.keys(pushed).length ? `\n\nPushed: ${JSON.stringify(pushed)}` : ""}`);
    if (cmp.regressions.length) process.exitCode = 3;
    if (flags.min !== undefined) {
      const below = Object.entries(r.summary).filter(([, v]) => v.mean !== null && v.mean < Number(flags.min)).map(([k]) => k);
      if (below.length) {
        process.stderr.write(`ase: below --min ${flags.min}: ${below.join(", ")}\n`);
        process.exitCode = 4;
      }
    }
    break;
  }
  case "observability": {
    const [sub, which] = positionals;
    const backend = BACKENDS.find((b) => b.id === which);
    if (sub === "connect") {
      if (!backend) fail(`usage: observability connect <${BACKENDS.map((b) => b.id).join("|")}>`);
      const secret = (await Bun.stdin.text()).trim();
      if (backend!.id === "langfuse") {
        const [pk, sk] = secret.includes(":") ? secret.split(":") : secret.split(/\s+/);
        if (!pk?.startsWith("pk-") || !sk?.startsWith("sk-")) fail('pipe "pk-lf-…:sk-lf-…" (public and secret key) on stdin');
        saveCredential("LANGFUSE_PUBLIC_KEY", pk!);
        saveCredential("LANGFUSE_SECRET_KEY", sk!);
        if (flags.host) saveCredential("LANGFUSE_HOST", flags.host as string);
      } else if (backend!.id === "braintrust") {
        if (!secret || /\s/.test(secret)) fail("pipe the Braintrust API key on stdin");
        saveCredential("BRAINTRUST_API_KEY", secret);
        if (flags["api-url"]) saveCredential("BRAINTRUST_API_URL", flags["api-url"] as string);
        if (flags.project) saveCredential("BRAINTRUST_PROJECT", flags.project as string);
      } else {
        if (!secret || /\s/.test(secret)) fail("pipe the LangSmith API key on stdin");
        saveCredential("LANGSMITH_API_KEY", secret);
        if (flags.endpoint) saveCredential("LANGSMITH_ENDPOINT", flags.endpoint as string);
        if (flags.project) saveCredential("LANGSMITH_PROJECT", flags.project as string);
      }
      loadCredentials(findWorkspace(flags.workspace as string | undefined));
      const v = await backend!.verify(process.env);
      out({ backend: backend!.id, connected: v.ok, detail: v.detail, enabled: v.ok ? ["traces of every run", "eval scores (ase eval run --push)", "datasets (ase dataset push)"] : [] },
        v.ok ? `${backend!.label} connected — ${v.detail}. Traces, eval scores (--push) and datasets now go there.` : `Saved, but the connection check failed: ${v.detail}`);
      if (!v.ok) process.exitCode = 2;
    } else if (sub === "disconnect") {
      if (!backend) fail(`usage: observability disconnect <${BACKENDS.map((b) => b.id).join("|")}>`);
      out({ removed: removeCredentials(backend!.keys) });
    } else {
      const rows = [];
      for (const b of BACKENDS) rows.push({ backend: b.id, connected: b.configured(process.env), check: b.configured(process.env) ? (await b.verify(process.env)).detail : null });
      out({ backends: rows, generic_otlp: tracesUrl() ?? null }, rows.map((r) => `${r.connected ? "●" : "○"} ${r.backend}${r.check ? ` — ${r.check}` : ""}`).join("\n"));
    }
    break;
  }
  case "dataset": {
    const w = ws();
    if (positionals[0] !== "push") fail("usage: dataset push --icp <slug> [--mode full|light] [--name <dataset>]");
    const icp = (flags.icp as string) ?? fail("--icp is required");
    const mode = ((flags.mode as string) ?? "full") as "light" | "full";
    const items = await buildDataset(w, icp, mode);
    const name = (flags.name as string) ?? `ase-${icp}-${mode}`;
    const backends = connectedBackends();
    if (!backends.length) fail("no observability backend connected (ase observability connect langfuse|langsmith|braintrust)");
    const res: Record<string, unknown> = {};
    for (const b of backends) res[b.id] = await b.pushDataset(process.env, name, items).catch((e) => ({ error: (e as Error).message }));
    out({ dataset: name, items: items.length, pushed: res });
    break;
  }
  case "keys": {
    const sub = positionals[0];
    if (sub === "set") {
      const key = positionals[1] as (typeof KEYS)[number];
      if (!KEYS.includes(key)) fail(`usage: keys set <${KEYS.join("|")}>  (value on stdin)`);
      const value = (await Bun.stdin.text()).trim();
      if (!value || /\s/.test(value)) fail("no value on stdin (pipe it in, e.g. `pbpaste | bun ase.ts keys set EXA_API_KEY`)");
      out({ saved: key, value: mask(value), file: saveCredential(key, value) });
    } else if (sub === "pull-firecrawl") {
      const tmp = join(mkdtempSync(join(tmpdir(), "ase-fc-")), "fc.env");
      const p = Bun.spawnSync(["npx", "-y", "firecrawl-cli@1.26.5", "env", "-f", tmp, "--overwrite"], { stdout: "pipe", stderr: "pipe" });
      const val = existsSync(tmp) ? parseEnv(readFileSync(tmp, "utf8")).FIRECRAWL_API_KEY : undefined;
      rmSync(dirname(tmp), { recursive: true, force: true });
      if (p.exitCode !== 0 || !val) fail(`could not read a key from the Firecrawl CLI — log in first: npx -y firecrawl-cli@1.26.5 login --browser\n${p.stderr.toString().slice(0, 300)}`);
      out({ saved: "FIRECRAWL_API_KEY", value: mask(val), file: saveCredential("FIRECRAWL_API_KEY", val!) });
    } else {
      out({
        file: credentialsPath(),
        file_mode: credentialsFileMode(),
        keys: Object.fromEntries(KEYS.map((k) => [k, { set: Boolean(process.env[k]), value: mask(process.env[k]), from: keyOrigin[k] ?? null }])),
        tier: tier(),
      });
    }
    break;
  }
  case "outcomes": {
    const w = ws();
    const sub = positionals[0] ?? "stats";
    const icp = flags.icp as string | undefined;
    if (sub === "migrate") out(migrateLegacy(w));
    else if (sub === "open") {
      const items = openItems(accountStates(readEvents(w, icp)));
      out(items.map((i) => ({ account: i.account, icp: i.icp, status: i.status, prompt: i.prompt, days_since_touch: i.days_since_touch, people: i.people, channels: i.channels, urgency: i.urgency })));
    } else if (sub === "state") {
      const d = normalizeDomain(positionals[1] ?? "") ?? fail("usage: outcomes state <domain>");
      out([...accountStates(readEvents(w, icp)).values()].filter((x) => x.account === d));
    } else if (sub === "cases") out(await winLossCases(w, icp ?? fail("--icp is required"), flags.since as string | undefined));
    else out(await outcomeStats(w, icp ?? fail("--icp is required")));
    break;
  }
  case "outcome": {
    const w = ws();
    const [sub, domainRaw, type] = positionals;
    if (sub !== "log" || !domainRaw || !type) fail("usage: outcome log <domain> <event> --icp <slug> [...]  (see `ase help`)");
    const legacy: Record<string, string> = { meeting: "meeting_held" };
    try {
      const e = logEvent(w, {
        account: normalizeDomain(domainRaw!) ?? domainRaw!,
        icp: (flags.icp as string) ?? fail("--icp is required"),
        type: (legacy[type!] ?? type) as EventType,
        person: flags.person as string | undefined,
        member: (flags.member as string[] | undefined)?.[0],
        channel: flags.channel as OutcomeEvent["channel"],
        reason: flags.reason as OutcomeEvent["reason"],
        value_eur: flags.value !== undefined ? Number(flags.value) : undefined,
        note: flags.note as string | undefined,
        date: flags.date as string | undefined,
      });
      const state = accountStates(readEvents(w, e.icp)).get(`${e.account}|${e.icp}`);
      out({ logged: e, state: state ? { status: state.status, engaged: state.engaged } : null, ...(e.type === "unsubscribed" ? { reminder: "add the person to the do-not-contact list: ase dnc add linkedin|email <value> --reason opted_out" } : {}) });
    } catch (err) {
      const msg = err instanceof Error && "issues" in err ? (err as { issues: { message: string; path: (string | number)[] }[] }).issues.map((i) => `${i.path.join(".") || "event"}: ${i.message}`).join("; ") : (err as Error).message;
      fail(msg, 2);
    }
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
      const sub = subscriptionUsage(entries);
      out({ days, claude_billing: claudeBilling((await loadConfig(w).catch(() => null))?.claude_billing), total_usd: sumSpend(entries), today_usd: spentToday(w), byProvider, byRun, ...(sub ? { claude_on_subscription_usd_equivalent: sub } : {}), active_run: currentRun(w) });
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

await shutdownTracing();
