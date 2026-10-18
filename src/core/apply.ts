import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { autoJudge, type AutoRule } from "./autojudge.ts";
import { advanceStage } from "./waysin.ts";
import { parseDoc, readDoc, stringifyDoc } from "./frontmatter.ts";
import { normalizeLinkedIn, personId } from "./normalize.ts";
import { BRIEF_SECTIONS, Fact, FactorScore, SIGNAL_TYPES, type Company, type Person, type Signal } from "./schemas.ts";
import { factorsFor } from "./score.ts";
import { loadScoring, writeScore } from "./scorefile.ts";
import { validateContent } from "./validate.ts";
import { dncMatcher, loadConfig, loadDnc, paths, today } from "./workspace.ts";
import { briefSkeleton } from "./accounts.ts";
import { findQuote, snapshotIndex } from "./snapshots.ts";

/**
 * Structured writes: a stage session sends ONE compact JSON for a whole chunk of accounts and the engine does the
 * file work — merge facts, rewrite brief sections and footnotes, create people and signal files, auto-judge rule
 * factors, compute the score, advance the stage. Validated per account before anything is written (all-or-nothing
 * per account), so there are no rejected-write retries and the model never re-types whole markdown files.
 */

const FactIn = Fact.omit({ retrieved_at: true }).extend({ retrieved_at: z.string().optional() });

export const SourceIn = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  date: z.string().optional(),
  /** the exact words (≤ 40) on that page that support the footnoted statement */
  quote: z.string().min(3),
  raw_ref: z.string().optional(),
});
type SourceIn = z.infer<typeof SourceIn>;

const MONTHS = [
  ["jan", "januari", "janvier", "januar"], ["feb", "februari", "février", "februar"], ["mar", "maart", "mars", "märz", "march"],
  ["apr", "april", "avril"], ["may", "mei", "mai"], ["jun", "juni", "juin", "june"], ["jul", "juli", "juillet", "july"],
  ["aug", "augustus", "août", "august"], ["sep", "september", "septembre", "sept"], ["oct", "oktober", "octobre", "october"],
  ["nov", "november", "novembre"], ["dec", "december", "décembre", "dezember"],
];
/** Is an ISO date backed by a quote: the year plus the month as a number or a name (any common language)? */
function dateBacked(year: string, month: number, text: string): boolean {
  if (!text.includes(year)) return false;
  const low = text.toLowerCase();
  if (new RegExp(`(^|\\D)0?${month}(\\D|$)`).test(text.replace(year, " "))) return true;
  return (MONTHS[month - 1] ?? []).some((name) => new RegExp(`\\b${name}`).test(low));
}

/** Render a checked source as a footnote: label, URL, date, and the quote it rests on. */
export function renderSource(s: SourceIn): string {
  const q = s.quote.replace(/\s+/g, " ").trim();
  return `${s.label}, ${s.url}${s.date ? ` (${s.date})` : ""} — “${q.length > 220 ? `${q.slice(0, 217)}…` : q}”`;
}

const AccountUpdate = z.object({
  domain: z.string(),
  facts: z.record(z.string(), FactIn).optional(),
  /** brief sections to (re)write, by heading — e.g. { "Snapshot": "… [^s1]" } */
  sections: z.record(z.string(), z.string()).optional(),
  /**
   * footnote definitions used in sections. A web source carries the exact words the statement rests on, checked
   * against the saved page: { s1: { label: "About page", url: "https://…", date: "2026-10-15", quote: "…", raw_ref? } }.
   * Plain strings are only for non-web sources ("import:…", "user:…").
   */
  sources: z.record(z.string(), z.union([z.string(), SourceIn])).optional(),
  /** replaces the Open questions section; use "- [x] q → answer[^id]" and "- [ ] q (owner: <stage>)" */
  open_questions: z.array(z.string()).optional(),
  people: z.array(z.object({
    name: z.string(), title: z.string().optional(), linkedin_url: z.string().optional(), persona: z.string().optional(),
    seniority: z.enum(["c_level", "vp", "director", "manager", "ic", "owner", "other"]).optional(),
    source_url: z.string(), confidence: z.number().min(0).max(1), raw_ref: z.string().optional(),
  })).optional(),
  signals: z.array(z.object({
    type: z.enum(SIGNAL_TYPES), title: z.string(), date: z.string(), source_url: z.string(), confidence: z.number().min(0).max(1),
    relevance: z.number().int().min(0).max(3), raw_ref: z.string().optional(), note: z.string().optional(), ttl_days: z.number().int().positive().optional(),
  })).optional(),
  judgements: z.array(z.unknown()).optional(),
  mode: z.enum(["light", "full"]).optional(),
  /** advance to this stage after writing (contracts are checked) — e.g. "researched" */
  stage: z.enum(["researched", "outreach_ready"]).optional(),
  changelog: z.string().optional(),
});
export const ApplyInput = z.object({ icp: z.string(), member: z.string().optional(), accounts: z.array(AccountUpdate).min(1) });
export type ApplyInput = z.infer<typeof ApplyInput>;

interface AccountResult { domain: string; ok: boolean; errors: string[]; written: string[]; stage?: string | null; score?: { total: number; tier: string; coverage: number } }

/** Footnote ids in `sources` that the brief already defines differently and still cites in a section that stays. */
export function footnoteClashes(brief: string, sections: Record<string, string>, sources: Record<string, string>, replacesOpenQuestions: boolean): string[] {
  const defs = new Map([...brief.matchAll(/^\[\^([^\]]+)\]:\s*(.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()] as const));
  const kept = [...brief.replace(/^\[\^[^\]]+\]:.*$/gm, "").matchAll(/^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)]
    .filter((m) => !(m[1]!.trim() in sections) && !(replacesOpenQuestions && m[1]!.trim() === "Open questions"))
    .map((m) => [m[1]!.trim(), m[2]!] as const);
  const out: string[] = [];
  for (const [id, def] of Object.entries(sources)) {
    const old = defs.get(id);
    if (old === undefined || old === def.trim()) continue;
    const users = kept.filter(([, body]) => body.includes(`[^${id}]`)).map(([h]) => h);
    if (users.length) out.push(`sources.${id}: [^${id}] already cites another source in ${users.join(", ")}. Use a new footnote id`);
  }
  return out;
}

/** Rebuild a brief body with replaced sections, merged footnote definitions and a changelog line. */
export function rebuildBrief(body: string, sections: Record<string, string>, sources: Record<string, string>, openQuestions: string[] | undefined, changelog: string | undefined): string {
  const lines = body.split("\n");
  const defs = new Map<string, string>();
  const kept: string[] = [];
  for (const l of lines) {
    const m = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(l);
    if (m) defs.set(m[1]!, m[2]!);
    else kept.push(l);
  }
  for (const [k, v] of Object.entries(sources)) defs.set(k, v);
  const text = kept.join("\n");
  const head = text.split(/^##\s/m)[0]!.trimEnd();
  const parsed = new Map<string, string>();
  for (const m of text.matchAll(/^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)) parsed.set(m[1]!.trim(), m[2]!.trim());
  for (const [k, v] of Object.entries(sections)) parsed.set(k, v.trim());
  if (openQuestions) parsed.set("Open questions", openQuestions.join("\n"));
  if (changelog) parsed.set("Changelog", `${parsed.get("Changelog") ?? ""}\n- ${today()} ${changelog}`.trim());
  const order = [...BRIEF_SECTIONS, ...[...parsed.keys()].filter((k) => !(BRIEF_SECTIONS as readonly string[]).includes(k))];
  const out = [head, ""];
  for (const s of order) out.push(`## ${s}`, parsed.get(s) ?? "", "");
  if (defs.size) out.push(...[...defs].map(([k, v]) => `[^${k}]: ${v}`), "");
  return out.join("\n");
}

async function applyAccount(ws: string, icp: string, u: z.infer<typeof AccountUpdate>, privacyMode: boolean, dnc: ReturnType<typeof dncMatcher>): Promise<AccountResult> {
  const res: AccountResult = { domain: u.domain, ok: false, errors: [], written: [] };
  const cp = paths.company(ws, u.domain);
  if (!existsSync(cp)) return { ...res, errors: ["no account file — discover or import it first"] };
  const pending: { rel: string; content: string }[] = [];

  // facts: never overwrite a higher-confidence fact with a lower one
  const company = await readDoc<Company>(cp);
  for (const [k, f] of Object.entries(u.facts ?? {})) {
    const prev = company.data.facts?.[k];
    if (prev && prev.confidence > f.confidence && String(prev.value) !== String(f.value)) continue;
    company.data.facts = { ...(company.data.facts ?? {}), [k]: { ...f, retrieved_at: f.retrieved_at ?? today() } as z.infer<typeof Fact> };
  }
  pending.push({ rel: `accounts/${u.domain}/company.md`, content: stringifyDoc(company.data, company.body) });

  // sources: every web footnote must quote words that are really on its saved page
  const renderedSources: Record<string, string> = {};
  const snapIdx = Object.values(u.sources ?? {}).some((v) => typeof v !== "string") ? snapshotIndex(ws) : undefined;
  for (const [id, v] of Object.entries(u.sources ?? {})) {
    if (typeof v === "string") {
      if (/https?:\/\//.test(v)) res.errors.push(`sources.${id}: a web source needs {label, url, date, quote} — the exact words on that page the statement rests on`);
      else renderedSources[id] = v;
      continue;
    }
    const found = findQuote(ws, v.quote, v.url, v.raw_ref, snapIdx);
    if (!found) {
      res.errors.push(`sources.${id}: "${v.quote.slice(0, 80)}" is not on the saved page for ${v.url}${v.raw_ref ? ` (${v.raw_ref})` : ""}. Quote the page's exact words, cite the page that says it, or drop that detail from the statement`);
      continue;
    }
    renderedSources[id] = renderSource({ ...v, raw_ref: found });
  }
  // Every number in a footnoted statement must be in one of its footnotes' quotes: numbers (counts, years, sizes) are
  // where added details hide. Statements citing only older footnotes or non-web sources are not checked here.
  const quotes = new Map(Object.entries(u.sources ?? {}).flatMap(([id, v]) => (typeof v === "string" ? [] : [[id, v.quote] as const])));
  for (const [section, text] of Object.entries(u.sections ?? {})) {
    for (const stmt of text.split(/(?<=[.!?])\s+|\n+/)) {
      const ids = [...stmt.matchAll(/\[\^([^\]]+)\]/g)].map((m) => m[1]!);
      if (!ids.length || !ids.every((id) => quotes.has(id))) continue;
      const backing = ids.map((id) => quotes.get(id)!.replace(/[.,](?=\d)/g, "")).join(" ");
      const missing: string[] = [];
      // ISO dates (the engine's own format) need the year and the month (number or name) in a quote, not the same format.
      let rest = stmt.replace(/\[\^[^\]]+\]/g, "");
      for (const m of rest.matchAll(/\b(\d{4})-(\d{2})(?:-\d{2})?\b/g)) {
        if (!dateBacked(m[1]!, Number(m[2]), backing)) missing.push(m[0]);
      }
      rest = rest.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " ");
      const nums = (rest.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]/g, ""));
      missing.push(...[...new Set(nums)].filter((n) => !new RegExp(`(^|\\D)${n}(\\D|$)`).test(backing)));
      if (missing.length) res.errors.push(`${section}: "${stmt.slice(0, 90)}" has ${missing.join(", ")} but no quote of ${ids.map((i) => `[^${i}]`).join(" ")} contains it. Quote the words with that number, or leave it out`);
    }
  }
  // a footnote id the brief already uses for another source, in a section this update keeps, would silently re-point
  // that section's statements at the wrong source
  const bp0 = paths.brief(ws, u.domain);
  if (existsSync(bp0)) res.errors.push(...footnoteClashes(readFileSync(bp0, "utf8"), u.sections ?? {}, renderedSources, Boolean(u.open_questions)));
  if (res.errors.length) return res;

  // brief
  if (u.sections || u.open_questions || u.changelog) {
    const bp = paths.brief(ws, u.domain);
    const brief = existsSync(bp) ? await readDoc<{ account: string; sections_updated?: Record<string, string>; open_questions?: number }>(bp) : parseDoc<{ account: string; sections_updated?: Record<string, string>; open_questions?: number }>(briefSkeleton(u.domain, company.data.name, "created by apply"));
    const updated = { ...(brief.data.sections_updated ?? {}) };
    for (const s of Object.keys(u.sections ?? {})) updated[s] = today();
    if (u.open_questions) updated["Open questions"] = today();
    const body = rebuildBrief(brief.body, u.sections ?? {}, renderedSources, u.open_questions, u.changelog);
    const open = (u.open_questions ?? []).filter((q) => /^\s*-\s*\[ \]/.test(q)).length;
    const data = { ...brief.data, account: u.domain, sections_updated: updated, open_questions: u.open_questions ? open : (brief.data.open_questions ?? 0) };
    pending.push({ rel: `accounts/${u.domain}/brief.md`, content: stringifyDoc(data, body) });
  }

  // people
  for (const p of u.people ?? []) {
    const li = normalizeLinkedIn(p.linkedin_url) ?? undefined;
    const id = personId(li, p.name, u.domain);
    const ppath = paths.person(ws, id);
    const prev = existsSync(ppath) ? await readDoc<Person>(ppath) : null;
    const person: Person = {
      ...(prev?.data ?? { id, name: p.name, lawful_basis: "legitimate_interest", dnc: false, known_by: [], facts: {} }),
      id, name: p.name, company: u.domain, ...(li ? { linkedin_url: li } : {}), ...(p.persona ? { persona: p.persona } : {}), ...(p.seniority ? { seniority: p.seniority } : {}),
      facts: { ...(prev?.data.facts ?? {}), ...(p.title ? { title: { value: p.title, source_url: p.source_url, retrieved_at: today(), confidence: p.confidence, ...(p.raw_ref ? { raw_ref: p.raw_ref } : {}) } } : {}) },
    } as Person;
    pending.push({ rel: `people/${id}.md`, content: stringifyDoc(person, prev?.body ?? "Business-relevant context only.\n") });
  }

  // signals
  for (const s of u.signals ?? []) {
    let rel = `accounts/${u.domain}/signals/${s.date.slice(0, 10)}-${s.type}.md`;
    for (let i = 2; existsSync(join(ws, rel)) || pending.some((x) => x.rel === rel); i++) rel = `accounts/${u.domain}/signals/${s.date.slice(0, 10)}-${s.type}-${i}.md`;
    const data = { account: u.domain, type: s.type, title: s.title, date: s.date, source_url: s.source_url, retrieved_at: today(), confidence: s.confidence, relevance: { [icp]: s.relevance }, ttl_days: s.ttl_days ?? 180, status: "new", ...(s.raw_ref ? { raw_ref: s.raw_ref } : {}) };
    pending.push({ rel, content: stringifyDoc(data, `${s.note ?? ""}\n`) });
  }

  // validate everything first; write nothing for this account if anything is invalid
  for (const p of pending) {
    const errs = validateContent(p.rel, p.content, { privacyMode, dnc, exists: existsSync(join(ws, p.rel)) });
    for (const e of errs) res.errors.push(`${p.rel}: ${e}`);
  }
  if (res.errors.length) return res;
  for (const p of pending) {
    mkdirSync(dirname(join(ws, p.rel)), { recursive: true });
    writeFileSync(join(ws, p.rel), p.content);
    res.written.push(p.rel);
  }

  // Writing a Ways in section for a scored account is what makes it outreach-ready, unless the update holds it back
  // with an open question owned by ways_in (seen twice on the bench: the section written, the stage forgotten).
  const held = (u.open_questions ?? []).some((q) => /^\s*-\s*\[ \]/.test(q) && /owner:\s*ways[_-]?in/i.test(q));
  const stage = u.stage ?? (u.sections?.["Ways in"] && !held && company.data.icp_status?.[icp]?.stage === "scored" ? "outreach_ready" : undefined);
  if (stage) {
    const a = await advanceStage(ws, u.domain, icp, stage);
    if (!a.advanced) res.errors.push(...a.errors.map((e) => `stage ${stage}: ${e}`));
  }

  // score: model judgements + rule-based factors
  if (u.judgements || u.mode) {
    const mode = u.mode ?? "light";
    const scoring = await loadScoring(ws, icp);
    const parsed = (u.judgements ?? []).map((j) => ({ j, r: FactorScore.safeParse(j) }));
    // an invalid judgement is an error to fix, not something to drop: a silently missing factor skews the score
    const invalid = parsed.filter((p) => !p.r.success).map((p) => `judgement ${(p.j as { id?: string })?.id ?? "?"}: ${p.r.error!.issues.map((i) => i.message).join("; ")}`);
    if (invalid.length) {
      res.errors.push(...invalid);
      res.stage ??= (await readDoc<Company>(cp)).data.icp_status?.[icp]?.stage ?? null;
      res.ok = false;
      return res;
    }
    const judged = parsed.map((p) => p.r.data!);
    const fresh = (await readDoc<Company>(cp)).data;
    const sdir = join(ws, "accounts", u.domain, "signals");
    const signals = existsSync(sdir) ? await Promise.all(readdirSync(sdir).filter((f) => f.endsWith(".md")).map(async (f) => (await readDoc<Signal>(join(sdir, f))).data)) : [];
    const stage = fresh.icp_status?.[icp]?.stage;
    const researched = mode === "full" && ["researched", "scored", "outreach_ready", "engaged"].includes(String(stage));
    for (const f of factorsFor(scoring, mode) as (ReturnType<typeof factorsFor>[number] & { auto?: AutoRule })[]) {
      if (!f.auto) continue;
      const a = autoJudge(f, fresh, { signals, researched });
      const i = judged.findIndex((j) => j.id === f.id);
      if (a && (i < 0 || judged[i]!.level === null)) {
        if (i >= 0) judged.splice(i, 1);
        judged.push(a);
      }
    }
    try {
      const s = await writeScore({ ws, icp, domain: u.domain, mode, judgements: judged });
      res.score = { total: s.total, tier: s.tier, coverage: s.coverage };
      res.stage = s.stage;
      res.written.push(s.path);
    } catch (e) {
      res.errors.push(`score: ${(e as Error).message}`);
    }
  }
  res.stage ??= (await readDoc<Company>(cp)).data.icp_status?.[icp]?.stage ?? null;
  res.ok = res.errors.length === 0;
  return res;
}

export async function applyUpdates(ws: string, raw: unknown) {
  const input = ApplyInput.parse(raw);
  const cfg = await loadConfig(ws).catch(() => null);
  const dnc = dncMatcher(await loadDnc(ws).catch(() => ({ entries: [] })));
  const results: AccountResult[] = [];
  for (const u of input.accounts) results.push(await applyAccount(ws, input.icp, u, cfg?.privacy_mode ?? true, dnc));
  return { ok: results.every((r) => r.ok), applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

export function readApplyFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
