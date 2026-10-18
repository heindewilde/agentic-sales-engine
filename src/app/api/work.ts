import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, reindexAll } from "../../core/db.ts";
import { addDnc, checkDnc } from "../../core/dnc.ts";
import { listDrafts, markDraft, saveDraft } from "../../core/drafts.ts";
import { health } from "../../core/doctor.ts";
import { parseDoc, readDoc } from "../../core/frontmatter.ts";
import { approveIcp, awaitingReview, reviewScores } from "../../core/gates.ts";
import { readLedger } from "../../core/ledger.ts";
import { EVENT_TYPES, REASONS, accountStates, logEvent, openItems, outcomeStats, readEvents, winLossCases } from "../../core/outcomes.ts";
import type { Company, ScoreFile } from "../../core/schemas.ts";
import { loadScoring, rank } from "../../core/scorefile.ts";
import { approveShortlist, proposedDomains, tickedDomains } from "../../core/shortlist.ts";
import { addWatch, loadWatchlist, removeWatch } from "../../core/watch.ts";
import { advanceStage } from "../../core/waysin.ts";
import { loadConfig, paths } from "../../core/workspace.ts";

/**
 * The work side of the app: what's waiting for you, accounts, the gates and drafts. Reads come from the workspace;
 * every change goes through an engine function (the same one the CLI uses), so validation and contracts apply.
 */

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const domainOf = (v: unknown) => {
  const d = String(v ?? "").toLowerCase();
  if (!DOMAIN.test(d)) throw new Error(`not a domain: ${d}`);
  return d;
};

/** The newest shortlist proposal still waiting for approval, per ICP. */
function pendingShortlist(ws: string, icp: string) {
  const dir = join(ws, "lists", icp);
  if (!existsSync(dir)) return null;
  for (const run of readdirSync(dir).sort().reverse()) {
    const f = join(dir, run, "shortlist.md");
    if (!existsSync(f)) continue;
    const { data, body } = parseDoc<{ status?: string; cost?: { total_p50?: number; total_p90?: number } }>(readFileSync(f, "utf8"));
    if (data.status !== "proposed") continue;
    return { file: `lists/${icp}/${run}/shortlist.md`, run, accounts: tickedDomains(body).length, rows: proposedDomains(body).length, cost: data.cost ?? null };
  }
  return null;
}

/** Everything waiting for a person, each with the screen that resolves it. */
export async function today(ws: string) {
  const h = await health(ws);
  const items: { kind: string; icp?: string; title: string; detail: string; href: string; urgency: number }[] = [];
  for (const i of h.icps) {
    if (i.status !== "approved") items.push({ kind: "gate", icp: i.slug, title: `Approve the ICP "${i.slug}"`, detail: "Nothing runs for this ICP until you approve who you sell to.", href: `/today/icp/${i.slug}`, urgency: 5 });
    const sl = pendingShortlist(ws, i.slug);
    if (sl) {
      const cost = sl.cost?.total_p50 != null ? ` · about $${sl.cost.total_p50}${sl.cost.total_p90 ? `–${sl.cost.total_p90}` : ""}` : "";
      items.push({ kind: "gate", icp: i.slug, title: `Approve the shortlist: ${sl.accounts} accounts for deep research`, detail: `Proposed from ${sl.rows} light-scored accounts${cost}.`, href: `/today/shortlist/${i.slug}`, urgency: 4 });
    }
    const review = await awaitingReview(ws, i.slug);
    if (review.length) items.push({ kind: "gate", icp: i.slug, title: `Review ${review.length} new full score${review.length === 1 ? "" : "s"}`, detail: "Tier A/B accounts researched and scored; confirm them before ways in and outreach.", href: `/today/scores/${i.slug}`, urgency: 4 });
  }
  const drafts = (await listDrafts(ws)).filter((d) => d.status === "draft" || d.status === "edited");
  if (drafts.length) items.push({ kind: "drafts", title: `${drafts.length} draft${drafts.length === 1 ? "" : "s"} to edit and send`, detail: `${[...new Set(drafts.map((d) => d.account))].slice(0, 4).join(", ")}${drafts.length > 4 ? "…" : ""}`, href: "/today/drafts", urgency: 3 });
  const open = openItems(accountStates(readEvents(ws))).filter((x) => x.urgency >= 3);
  if (open.length) items.push({ kind: "outcomes", title: `${open.length} account${open.length === 1 ? "" : "s"} need a status update`, detail: open.slice(0, 3).map((x) => `${x.account}: ${x.prompt}`).join(" · "), href: "/outcomes", urgency: 2 });
  if (h.staleFacts) items.push({ kind: "stale", title: `${h.staleFacts} facts are past their expiry`, detail: "A refresh re-checks them (headcounts, titles, where people work).", href: "/runs?skill=refresh", urgency: 1 });
  const week = Date.now() - 7 * 86_400_000;
  const spend = readLedger(ws).filter((e) => Date.parse(e.ts) >= week && e.kind === "actual");
  return {
    items: items.sort((a, b) => b.urgency - a.urgency),
    funnel: h.stages,
    icps: h.icps,
    billing: h.claudeBilling,
    tier: h.tier,
    run: h.run,
    problems: h.problems,
    spend_week: {
      billed: round(spend.filter((e) => e.billed !== false).reduce((a, e) => a + e.usd, 0)),
      covered_by_plan: round(spend.filter((e) => e.billed === false).reduce((a, e) => a + e.usd, 0)),
    },
  };
}
const round = (x: number) => Math.round(x * 100) / 100;

/** The account table: one row per account and ICP, from the index. */
export function accounts(ws: string, q: { icp?: string; stage?: string; tier?: string; search?: string }) {
  const db = openDb(ws);
  try {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.icp) { where.push("ai.icp = ?"); args.push(q.icp); }
    if (q.stage) { where.push("ai.stage = ?"); args.push(q.stage); }
    if (q.tier) { where.push("ai.tier = ?"); args.push(q.tier); }
    if (q.search?.trim()) {
      // full-text over every indexed file; keep the accounts whose files match
      const term = q.search.trim().replace(/["*]/g, " ").split(/\s+/).filter(Boolean).map((t) => `"${t}"*`).join(" ");
      where.push(`(a.domain LIKE ? OR a.name LIKE ? OR a.domain IN (SELECT substr(path, 10, instr(substr(path, 10), '/') - 1) FROM fts WHERE fts MATCH ? AND path LIKE 'accounts/%'))`);
      args.push(`%${q.search.trim()}%`, `%${q.search.trim()}%`, term);
    }
    const rows = db.query(
      `SELECT a.domain, a.name, a.owner, a.hq_country, a.employees, a.industry, ai.icp, ai.stage, ai.light_score, ai.score, ai.upside, ai.coverage, ai.tier, ai.updated
       FROM account_icp ai JOIN accounts a ON a.domain = ai.domain ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY CASE ai.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END, COALESCE(ai.score, ai.light_score, 0) DESC LIMIT 500`,
    ).all(...args);
    return { rows };
  } finally {
    db.close();
  }
}

/** One account, everything a person needs to judge it. */
export async function account(ws: string, domain: string) {
  const d = domainOf(domain);
  const cp = paths.company(ws, d);
  if (!existsSync(cp)) throw new Error(`no account ${d}`);
  const company = (await readDoc<Company>(cp)).data;
  const brief = existsSync(paths.brief(ws, d)) ? readFileSync(paths.brief(ws, d), "utf8") : null;
  const scores: Record<string, unknown> = {};
  for (const icp of Object.keys(company.icp_status ?? {})) {
    const sp = join(ws, "accounts", d, "scores", `${icp}.md`);
    if (!existsSync(sp)) continue;
    const sf = (await readDoc<ScoreFile>(sp)).data;
    const model = await loadScoring(ws, icp).catch(() => null);
    const byId = new Map((model?.factors ?? []).map((f) => [f.id, f]));
    scores[icp] = {
      ...sf,
      factors: sf.factors.map((f) => {
        const m = byId.get(f.id);
        return { ...f, name: m?.name ?? f.id, group: m?.group, weight: m?.weight, question: m?.question, level_text: f.level != null ? m?.levels?.[f.level as 0 | 1 | 2 | 3] : null };
      }),
    };
  }
  const db = openDb(ws);
  let people: unknown[] = [];
  let signals: unknown[] = [];
  try {
    people = db.query("SELECT id, name, title, persona, linkedin_url, path FROM people WHERE company_domain = ? ORDER BY persona, name").all(d);
    signals = db.query("SELECT path, type, title, date, source_url, status, relevance_json FROM signals WHERE domain = ? ORDER BY date DESC").all(d);
  } finally {
    db.close();
  }
  const warm = db_warm(ws, d);
  return {
    domain: d,
    company,
    brief,
    scores,
    people,
    signals,
    warm,
    drafts: await listDrafts(ws, { account: d }),
    outcomes: readEvents(ws).filter((e) => e.account === d),
    watched: loadWatchlist(ws).entries.some((w) => w.account === d),
    blocked: (await checkDnc(ws, d)).blocked,
  };
}
function db_warm(ws: string, d: string) {
  const db = openDb(ws);
  try {
    return db.query("SELECT member, person_id, via, connected_on FROM warm_paths WHERE company_domain = ?").all(d);
  } finally {
    db.close();
  }
}

export async function icpDoc(ws: string, slug: string) {
  const p = paths.icp(ws, slug);
  if (!existsSync(p)) throw new Error(`no ICP ${slug}`);
  const text = readFileSync(p, "utf8");
  return { slug, text, ...parseDoc<Record<string, unknown>>(text).data };
}

/** The newest pending shortlist with its rows and the reasons the engine gives for each. */
export async function shortlist(ws: string, icp: string) {
  const sl = pendingShortlist(ws, icp);
  if (!sl) return { pending: null };
  const { data, body } = parseDoc<Record<string, unknown>>(readFileSync(join(ws, sl.file), "utf8"));
  const rows = [...body.matchAll(/^\|\s*\[([ xX])\]\s*\|\s*([a-z0-9.-]+\.[a-z]{2,})\s*\|([^\n]*)$/gm)].map((m) => {
    const cells = m[3]!.split("|").map((c) => c.trim());
    return { ticked: m[1]!.toLowerCase() === "x", domain: m[2]!, name: cells[0], light: cells[1], upside: cells[2], coverage: cells[3], needs_check: cells[4], why: cells[5] };
  });
  const intro = body.split(/^\|/m)[0]!.trim();
  return { pending: { ...sl, data, intro, rows } };
}

/** Scored accounts with who reviewed them (if anyone); factor ids shown as their names. */
export async function scoresToReview(ws: string, icp: string) {
  const model = await loadScoring(ws, icp).catch(() => null);
  const name = new Map((model?.factors ?? []).map((f) => [f.id, f.name ?? f.id]));
  const rows = await rank(ws, icp, { stage: "scored" });
  const out = [];
  for (const r of rows) {
    const st = (await readDoc<Company>(paths.company(ws, r.domain))).data.icp_status?.[icp];
    out.push({ ...r, reviewed_by: st?.reviewed_by ?? null, needs_check: r.needs_check.map((id) => name.get(id) ?? id) });
  }
  return { rows: out };
}

export async function drafts(ws: string) {
  const rows = (await listDrafts(ws)).filter((d) => d.status === "draft" || d.status === "edited");
  const db = openDb(ws);
  try {
    const name = (id?: string) => (id ? (db.query("SELECT name FROM people WHERE id = ?").get(id) as { name?: string } | null)?.name : undefined);
    return { rows: rows.map((r) => ({ ...r, person_name: name(r.person) ?? r.person })) };
  } finally {
    db.close();
  }
}

export async function draft(ws: string, rel: string) {
  if (!/^accounts\/[^/]+\/drafts\/[^/]+\.md$/.test(rel)) throw new Error("not a draft");
  const abs = join(ws, rel);
  if (!existsSync(abs)) throw new Error(`${rel} not found`);
  const doc = parseDoc<Record<string, unknown>>(readFileSync(abs, "utf8"));
  const d = rel.split("/")[1]!;
  const brief = existsSync(paths.brief(ws, d)) ? readFileSync(paths.brief(ws, d), "utf8") : "";
  const ways = /^## Ways in\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(brief)?.[1]?.trim() ?? "";
  const pid = String(doc.data.person ?? "");
  const pp = pid ? join(ws, "people", `${pid}.md`) : "";
  const person = pp && existsSync(pp) ? parseDoc<{ name?: string; title?: string }>(readFileSync(pp, "utf8")).data : null;
  return { path: rel, data: doc.data, body: doc.body, ways_in: ways, person: person ? { name: person.name, title: person.title } : null };
}

/** The weekly review (one question per open account), conversion by tier, and what was won and lost. */
export async function outcomes(ws: string, icp: string) {
  const open = icp ? openItems(accountStates(readEvents(ws, icp))) : [];
  const names = new Map<string, string>();
  for (const o of open) {
    const p = paths.company(ws, o.account);
    if (existsSync(p)) names.set(o.account, (await readDoc<Company>(p)).data.name ?? o.account);
  }
  return {
    open: open.map((o) => ({ account: o.account, name: names.get(o.account) ?? o.account, status: o.status, prompt: o.prompt, urgency: o.urgency, last_touch: o.last_touch, channels: o.channels })),
    stats: icp ? await outcomeStats(ws, icp) : null,
    cases: icp ? await winLossCases(ws, icp) : [],
  };
}

export const meta = async (ws: string) => {
  const cfg = await loadConfig(ws).catch(() => null);
  return { members: cfg?.members ?? [], event_types: EVENT_TYPES, reasons: REASONS };
};

/** The writes. `by` is the team member acting; every one is an engine function. */
export async function act(ws: string, action: string, b: Record<string, unknown>) {
  const by = String(b.by ?? "");
  const icp = b.icp ? String(b.icp) : undefined;
  const need = <T>(v: T | undefined, name: string): T => {
    if (v === undefined || v === null || v === "") throw new Error(`${name} is required`);
    return v;
  };
  switch (action) {
    case "icp/approve":
      return approveIcp(ws, need(icp, "icp"), by);
    case "shortlist/approve": {
      const r = await approveShortlist(ws, need(icp, "icp"), String(need(b.file, "file")), by, Array.isArray(b.domains) ? b.domains.map(domainOf) : undefined);
      await reindexAll(ws);
      return r;
    }
    case "scores/review": {
      const r = await reviewScores(ws, need(icp, "icp"), (b.domains as unknown[] ?? []).map(domainOf), by);
      await reindexAll(ws);
      return r;
    }
    case "draft/save":
      return saveDraft(ws, String(need(b.path, "path")), String(need(b.body, "body")));
    case "draft/mark": {
      const status = String(b.status);
      if (!["sent", "discarded", "draft", "edited"].includes(status)) throw new Error(`bad status ${status}`);
      return markDraft(ws, String(need(b.path, "path")), status as "sent", { member: by || undefined });
    }
    case "account/stage": {
      const r = await advanceStage(ws, domainOf(b.domain), need(icp, "icp"), need(b.to as never, "to"), b.reason ? String(b.reason) : undefined);
      await reindexAll(ws);
      return r;
    }
    case "account/watch":
      return b.on ? addWatch(ws, domainOf(b.domain), need(icp, "icp"), { by: by || undefined }) : removeWatch(ws, domainOf(b.domain), icp);
    case "account/block":
      return addDnc(ws, domainOf(b.domain), { kind: "domain", reason: (b.reason ?? "other") as never, note: b.note ? String(b.note) : undefined });
    case "outcome/log":
      return logEvent(ws, {
        account: domainOf(b.domain), icp: need(icp, "icp"), type: need(b.type as never, "type"), member: by || undefined,
        reason: b.reason as never, note: b.note ? String(b.note) : undefined, person: b.person ? String(b.person) : undefined,
      } as never);
    default:
      throw new Error(`unknown action ${action}`);
  }
}
