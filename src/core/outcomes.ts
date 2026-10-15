import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import { parseYaml, readDoc } from "./frontmatter.ts";
import { normalizeDomain } from "./normalize.ts";
import type { Company, ScoreFile, Signal } from "./schemas.ts";
import { wilson } from "./stats.ts";
import { paths, today } from "./workspace.ts";

/**
 * Outcome tracking as an append-only event log (outcomes/events.jsonl — merge=union, so teammates' entries
 * merge cleanly in git). Each account's state is *derived* from its events: what happened, whether it ever
 * engaged, and how it ended. Silence is derived too: no event for NO_RESPONSE_DAYS after the last touch counts
 * as no_response until something else happens — nobody has to log it.
 */

export const EVENT_TYPES = [
  "sent", // a message went out (logged automatically when a draft is marked sent)
  "replied_positive", // interested / wants to talk
  "replied_neutral", // out of office, "ask me later", forwarded without opinion
  "replied_negative", // not interested
  "unsubscribed", // asked not to be contacted → also do-not-contact
  "meeting_booked",
  "meeting_held",
  "opportunity", // qualified deal in pipeline
  "won",
  "lost", // deal lost after engagement
  "disqualified", // we decided it's not a fit
  "no_response", // explicitly logged silence (normally derived)
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const REASONS = ["timing", "no_budget", "competitor", "no_pain", "wrong_person", "not_icp", "internal_build", "status_quo", "opted_out", "other"] as const;
export type Reason = (typeof REASONS)[number];
/** Events that need a reason code (the free note explains it). */
export const NEEDS_REASON: ReadonlySet<EventType> = new Set(["replied_negative", "lost", "disqualified"]);
/** Engaged = the account showed real interest: a positive reply or any later step. */
export const ENGAGED: ReadonlySet<EventType> = new Set(["replied_positive", "meeting_booked", "meeting_held", "opportunity", "won"]);
export const POSITIVE = ENGAGED; // kept for callers that predate the event log
export const NO_RESPONSE_DAYS = 21;
export const CHANNELS = ["email", "linkedin_connect", "linkedin_dm", "intro_request", "phone", "event", "other"] as const;

export const OutcomeEvent = z
  .object({
    ts: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    account: z.string().min(3),
    icp: z.string().min(1),
    type: z.enum(EVENT_TYPES),
    person: z.string().optional(),
    member: z.string().optional(),
    channel: z.enum(CHANNELS).optional(),
    draft: z.string().optional(),
    reason: z.enum(REASONS).optional(),
    value_eur: z.number().nonnegative().optional(),
    note: z.string().max(500).optional(),
    source: z.enum(["manual", "draft", "review", "legacy", "migrated"]).default("manual"),
  })
  .superRefine((e, ctx) => {
    if (NEEDS_REASON.has(e.type) && !e.reason) ctx.addIssue({ code: "custom", message: `${e.type} needs a reason code (${REASONS.join(", ")})` });
  });
export type OutcomeEvent = z.infer<typeof OutcomeEvent>;

export const eventsPath = (ws: string) => join(ws, "outcomes", "events.jsonl");
const legacyPath = (ws: string) => join(ws, "outcomes", "outcomes.csv");

/** Validate and append one event. Unsubscribes need the caller to also add a do-not-contact entry. */
export function logEvent(ws: string, input: Omit<OutcomeEvent, "ts" | "date" | "source"> & { ts?: string; date?: string; source?: OutcomeEvent["source"] }): OutcomeEvent {
  const account = normalizeDomain(input.account) ?? input.account;
  const reason = input.type === "unsubscribed" ? (input.reason ?? "opted_out") : input.reason;
  const e = OutcomeEvent.parse({ ...input, account, reason, ts: input.ts ?? new Date().toISOString(), date: input.date ?? today(), source: input.source ?? "manual" });
  const p = eventsPath(ws);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify(e)}\n`);
  return e;
}

const LEGACY_MAP: Record<string, EventType> = { meeting: "meeting_held", opportunity: "opportunity", won: "won", lost: "lost", no_response: "no_response", disqualified: "disqualified" };

function readLegacy(ws: string): OutcomeEvent[] {
  const p = legacyPath(ws);
  if (!existsSync(p)) return [];
  const rows = parseCsv(readFileSync(p, "utf8"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<string, string>[];
  const out: OutcomeEvent[] = [];
  for (const r of rows) {
    const type = LEGACY_MAP[r.outcome ?? ""];
    if (!type || !r.account || !r.icp) continue;
    out.push({
      ts: `${r.date}T00:00:00.000Z`, date: r.date ?? today(), account: r.account, icp: r.icp, type, member: r.member || undefined,
      note: r.note || undefined, reason: NEEDS_REASON.has(type) ? "other" : undefined, source: "legacy",
    } as OutcomeEvent);
  }
  return out;
}

/** All events (event log + any legacy outcomes.csv rows), oldest first. Malformed lines are skipped. */
export function readEvents(ws: string, icp?: string): OutcomeEvent[] {
  const out: OutcomeEvent[] = [];
  const p = eventsPath(ws);
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = OutcomeEvent.safeParse(JSON.parse(line));
        if (r.success) out.push(r.data);
      } catch {
        // tolerate a torn line from a concurrent writer
      }
    }
  }
  out.push(...readLegacy(ws));
  return out.filter((e) => !icp || e.icp === icp).sort((a, b) => a.date.localeCompare(b.date) || a.ts.localeCompare(b.ts));
}

/** Convert a legacy outcomes.csv into events and archive the CSV. */
export function migrateLegacy(ws: string): { migrated: number; archived: string | null } {
  const legacy = readLegacy(ws);
  if (!legacy.length) return { migrated: 0, archived: null };
  const p = eventsPath(ws);
  mkdirSync(dirname(p), { recursive: true });
  for (const e of legacy) appendFileSync(p, `${JSON.stringify({ ...e, source: "migrated" })}\n`);
  const archived = join(ws, "outcomes", `outcomes.legacy-${today()}.csv`);
  renameSync(legacyPath(ws), archived);
  return { migrated: legacy.length, archived: archived.slice(ws.length + 1) };
}

/** Coarse status per account, the vocabulary used in dashboards and analytics. */
export type Status = "open" | "no_response" | "engaged" | "meeting" | "opportunity" | "won" | "lost" | "disqualified" | "not_interested" | "opted_out";

export interface AccountState {
  account: string;
  icp: string;
  status: Status;
  /** ever showed real interest (positive reply or later) */
  engaged: boolean;
  won: boolean;
  /** silence derived from the 21-day rule rather than logged */
  derived_no_response: boolean;
  /** outreach still in flight (sent, waiting < 21 days) — excluded from conversion statistics */
  pending: boolean;
  first_sent: string | null;
  last_touch: string | null;
  days_since_touch: number | null;
  channels: string[];
  people: string[];
  reasons: Reason[];
  notes: string[];
  value_eur: number | null;
  history: { date: string; type: EventType; source: string }[];
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Derive each account's state from its events (as of `asOf`, default today). */
export function accountStates(events: OutcomeEvent[], asOf = today()): Map<string, AccountState> {
  const groups = new Map<string, OutcomeEvent[]>();
  for (const e of events) {
    const k = `${e.account}|${e.icp}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const out = new Map<string, AccountState>();
  for (const [k, evs] of groups) {
    const [account, icp] = k.split("|") as [string, string];
    const types = evs.map((e) => e.type);
    const has = (t: EventType) => types.includes(t);
    const last = evs[evs.length - 1]!;
    const touches = evs.filter((e) => e.type === "sent");
    const lastTouch = touches.length ? touches[touches.length - 1]!.date : null;
    // Any reaction after the last touch?
    const reactedAfterLastTouch = lastTouch ? evs.some((e) => e.type !== "sent" && e.date >= lastTouch && e.type !== "no_response") : false;

    let status: Status;
    let derived = false;
    let pending = false;
    if (has("won")) status = "won";
    else if (has("unsubscribed")) status = "opted_out";
    else if (last.type === "lost") status = "lost";
    else if (last.type === "disqualified") status = "disqualified";
    else if (has("opportunity")) status = "opportunity";
    else if (has("meeting_held") || has("meeting_booked")) status = "meeting";
    else if (has("replied_positive")) status = "engaged";
    else if (has("replied_negative")) status = "not_interested";
    else if (has("lost")) status = "lost";
    else if (has("disqualified")) status = "disqualified";
    else if (has("no_response") && !reactedAfterLastTouch && (!lastTouch || evs.some((e) => e.type === "no_response" && e.date >= lastTouch))) status = "no_response";
    else if (lastTouch && !reactedAfterLastTouch && daysBetween(lastTouch, asOf) >= NO_RESPONSE_DAYS) {
      status = "no_response";
      derived = true;
    } else {
      status = "open";
      pending = true;
    }
    const dates = evs.map((e) => e.date);
    out.set(k, {
      account, icp, status,
      engaged: evs.some((e) => ENGAGED.has(e.type)),
      won: has("won"),
      derived_no_response: derived,
      pending,
      first_sent: touches[0]?.date ?? null,
      last_touch: lastTouch ?? dates[dates.length - 1] ?? null,
      days_since_touch: lastTouch ? daysBetween(lastTouch, asOf) : null,
      channels: [...new Set(evs.map((e) => e.channel).filter((c): c is NonNullable<typeof c> => Boolean(c)))],
      people: [...new Set(evs.map((e) => e.person).filter((p): p is string => Boolean(p)))],
      reasons: [...new Set(evs.map((e) => e.reason).filter((r): r is Reason => Boolean(r)))],
      notes: evs.map((e) => e.note).filter((n): n is string => Boolean(n)),
      value_eur: evs.reduce<number | null>((v, e) => (e.value_eur !== undefined ? e.value_eur : v), null),
      history: evs.map((e) => ({ date: e.date, type: e.type, source: e.source })),
    });
  }
  return out;
}

/** Accounts that need attention in the weekly review, most urgent first. */
export function openItems(states: Map<string, AccountState>) {
  const items: (AccountState & { prompt: string; urgency: number })[] = [];
  for (const s of states.values()) {
    if (s.status === "open" && s.days_since_touch !== null && s.days_since_touch >= 14) {
      items.push({ ...s, prompt: `sent ${s.days_since_touch} days ago, no reaction — any reply? (becomes no_response at ${NO_RESPONSE_DAYS} days; consider a follow-up)`, urgency: 3 });
    } else if (s.status === "open") {
      items.push({ ...s, prompt: `sent ${s.days_since_touch ?? "?"} days ago — any reply yet?`, urgency: 1 });
    } else if (s.status === "engaged") {
      items.push({ ...s, prompt: "positive reply logged — meeting booked?", urgency: 4 });
    } else if (s.status === "meeting") {
      const last = s.history[s.history.length - 1]!;
      const age = daysBetween(last.date, today());
      items.push({ ...s, prompt: `${last.type === "meeting_booked" ? "meeting booked" : "meeting held"} ${age} days ago — what happened next?`, urgency: age > 14 ? 5 : 2 });
    } else if (s.status === "opportunity") {
      items.push({ ...s, prompt: "open opportunity — won, lost or still going?", urgency: 2 });
    }
  }
  return items.sort((a, b) => b.urgency - a.urgency || (b.days_since_touch ?? 0) - (a.days_since_touch ?? 0));
}

// ---------- analytics (status, win-loss, recalibration) ----------

function scoreOf(ws: string, domain: string, icp: string): ScoreFile | null {
  const p = paths.score(ws, domain, icp);
  if (!existsSync(p)) return null;
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(p, "utf8"));
  return m ? (parseYaml(m[1]!) as ScoreFile) : null;
}

async function signalTypes(ws: string, domain: string): Promise<string[]> {
  const dir = join(ws, "accounts", domain, "signals");
  if (!existsSync(dir)) return [];
  const types = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) types.add((await readDoc<Signal>(join(dir, f))).data.type);
  return [...types];
}

interface Bucket { n: number; engaged: number; won: number; rate: number | null; low: number; high: number }
const bucket = (rows: { engaged: boolean; won: boolean }[]): Bucket => {
  const engaged = rows.filter((r) => r.engaged).length;
  return { n: rows.length, engaged, won: rows.filter((r) => r.won).length, ...wilson(engaged, rows.length) };
};

/** Resolved accounts only (outreach still in flight would bias rates downward). */
export function resolvedStates(ws: string, icp: string): AccountState[] {
  return [...accountStates(readEvents(ws, icp)).values()].filter((s) => !s.pending);
}

export async function outcomeStats(ws: string, icp: string) {
  const all = [...accountStates(readEvents(ws, icp)).values()];
  const resolved = all.filter((s) => !s.pending);
  const rows = await Promise.all(
    resolved.map(async (s) => {
      const sc = scoreOf(ws, s.account, icp);
      return { ...s, tier: sc?.tier ?? null, total: sc?.total ?? null, mode: sc?.mode ?? null, signals: await signalTypes(ws, s.account) };
    }),
  );
  const byTier: Record<string, Bucket> = {};
  for (const t of ["A", "B", "C", "X", "unscored"]) {
    const sel = rows.filter((r) => (r.tier ?? "unscored") === t);
    if (sel.length) byTier[t] = bucket(sel);
  }
  const byTrigger: Record<string, Bucket> = {};
  for (const t of [...new Set(rows.flatMap((r) => r.signals))].sort()) byTrigger[t] = bucket(rows.filter((r) => r.signals.includes(t)));
  const noTrigger = rows.filter((r) => r.signals.length === 0);
  if (noTrigger.length) byTrigger["(none)"] = bucket(noTrigger);
  const byChannel: Record<string, Bucket> = {};
  for (const c of [...new Set(rows.flatMap((r) => r.channels))].sort()) byChannel[c] = bucket(rows.filter((r) => r.channels.includes(c)));
  const byStatus = Object.fromEntries([...new Set(all.map((s) => s.status))].sort().map((st) => [st, all.filter((s) => s.status === st).length]));
  const reasons: Record<string, number> = {};
  for (const r of rows) for (const x of r.reasons) reasons[x] = (reasons[x] ?? 0) + 1;

  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
  const scored = rows.filter((r) => r.total !== null);
  const full = rows.filter((r) => r.mode === "full");
  const fullPos = full.filter((r) => r.engaged).length;
  const ready = full.length >= 30 && fullPos >= 5 && full.length - fullPos >= 5;
  const A = byTier.A;
  const B = byTier.B;
  const tierSignal =
    A && B && A.n >= 5 && B.n >= 5
      ? A.low > B.high ? "tier A clearly converts better than B"
        : A.high < B.low ? "tier B converts better than A — the model is mis-ranking; run win-loss"
        : "A vs B difference not yet distinguishable (overlapping intervals)"
      : "too few resolved outcomes to compare tiers (need ≥ 5 per tier)";
  return {
    icp,
    accounts_tracked: all.length,
    in_flight: all.length - resolved.length,
    resolved: resolved.length,
    by_status: byStatus,
    overall: bucket(rows),
    by_tier: byTier,
    by_trigger: byTrigger,
    by_channel: byChannel,
    loss_reasons: reasons,
    median_score: { engaged: med(scored.filter((r) => r.engaged).map((r) => r.total!)), not_engaged: med(scored.filter((r) => !r.engaged).map((r) => r.total!)) },
    tier_signal: tierSignal,
    recalibration: { ready, full_scored_resolved: full.length, engaged: fullPos, needed: "≥30 resolved full-scored accounts incl. ≥5 engaged and ≥5 not" },
  };
}

/** Material for the win-loss skill: each resolved account with its score, signals, reasons, notes and brief. */
export async function winLossCases(ws: string, icp: string, since?: string) {
  const out = [];
  for (const s of resolvedStates(ws, icp)) {
    if (since && (s.last_touch ?? "") < since) continue;
    const sc = scoreOf(ws, s.account, icp);
    const cp = paths.company(ws, s.account);
    const brief = paths.brief(ws, s.account);
    out.push({
      account: s.account,
      name: existsSync(cp) ? (await readDoc<Company>(cp)).data.name : null,
      status: s.status, engaged: s.engaged, won: s.won, derived_no_response: s.derived_no_response,
      reasons: s.reasons, notes: s.notes, channels: s.channels, history: s.history,
      tier: sc?.tier ?? null, total: sc?.total ?? null,
      factor_levels: Object.fromEntries((sc?.factors ?? []).map((f) => [f.id, f.level])),
      signals: await signalTypes(ws, s.account),
      brief: existsSync(brief) ? `accounts/${s.account}/brief.md` : null,
    });
  }
  const order = (c: { engaged: boolean; status: string }) => (c.engaged ? 0 : c.status === "no_response" ? 2 : 1);
  return out.sort((a, b) => order(a) - order(b) || (b.history.at(-1)?.date ?? "").localeCompare(a.history.at(-1)?.date ?? ""));
}
