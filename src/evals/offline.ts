import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS } from "../core/contracts.ts";
import { parseDoc } from "../core/frontmatter.ts";
import { readLedger } from "../core/ledger.ts";
import { BRIEF_SECTIONS, STAGES, type Company, type Draft, type ScoreFile } from "../core/schemas.ts";

const STAGE_ORDER: readonly string[] = STAGES;
import { paths } from "../core/workspace.ts";
import { summarize, type EvalResult, type SuiteResult } from "./types.ts";

/**
 * Deterministic evaluators — no model calls, run in CI and before every change to skills or prompts.
 * They catch the failures that hurt most: evidence that doesn't say what we claim, drafts that break the
 * outreach rules, and handoffs that leave the next stage without what it needs.
 */

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[“”«»"']/g, "").replace(/[^a-z0-9€$%.,]+/g, " ").trim();

/** Does `quote` appear in `text`? Exact after normalization, or ≥ 85% of its words in one window (tolerates "…" and minor reformatting). */
export function quoteSupported(quote: string, text: string): boolean {
  const q = norm(quote.replace(/…|\.\.\./g, " "));
  const t = norm(text);
  if (!q) return false;
  if (t.includes(q)) return true;
  const qw = q.split(" ").filter((w) => w.length > 2);
  if (qw.length < 3) return false;
  const tw = t.split(" ");
  const need = Math.ceil(qw.length * 0.85);
  const span = Math.round(qw.length * 1.6) + 2;
  for (let i = 0; i < tw.length; i++) {
    const win = new Set(tw.slice(i, i + span));
    let hit = 0;
    for (const w of qw) if (win.has(w)) hit++;
    if (hit >= need) return true;
  }
  return false;
}

function accountDirs(ws: string): string[] {
  const dir = join(ws, "accounts");
  return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(paths.company(ws, d))) : [];
}

/** citation_faithfulness: every scored factor's quote must appear in its raw snapshot (when one is referenced). */
export function citationFaithfulness(ws: string): EvalResult[] {
  const out: EvalResult[] = [];
  for (const d of accountDirs(ws)) {
    const sdir = join(ws, "accounts", d, "scores");
    for (const f of existsSync(sdir) ? readdirSync(sdir).filter((x) => x.endsWith(".md")) : []) {
      const s = parseDoc<ScoreFile>(readFileSync(join(sdir, f), "utf8")).data;
      let checked = 0;
      let ok = 0;
      let unverifiable = 0;
      const failures: string[] = [];
      for (const fac of s.factors ?? []) {
        for (const e of fac.evidence ?? []) {
          if (!e.raw_ref) {
            unverifiable++;
            continue;
          }
          const raw = join(ws, e.raw_ref);
          checked++;
          if (existsSync(raw) && quoteSupported(e.quote, readFileSync(raw, "utf8"))) ok++;
          else failures.push(`${fac.id}: "${e.quote.slice(0, 80)}" not found in ${e.raw_ref}`);
        }
      }
      out.push({
        key: "citation_faithfulness",
        target: `accounts/${d}/scores/${f}`,
        score: checked ? ok / checked : null,
        comment: `${ok}/${checked} quotes found in their snapshot; ${unverifiable} evidence items without raw_ref`,
        failures,
      });
    }
  }
  return out;
}

const NEGATIVE_FINDING = /\b(not (publicly )?(identified|found|confirmed|disclosed)|no (\w+ ){0,4}(found|identified|evidence|source)|unknown|unconfirmed|could not (find|verify|confirm)|caveat)\b/i;

/** brief_grounding: share of written paragraphs/bullets in research sections that carry a footnote. */
export function briefGrounding(ws: string): EvalResult[] {
  const SECTIONS = ["Snapshot", "Business & offering", "Situation & triggers", "Technographics", "People map", "Ways in", "Risks & fit concerns"];
  const out: EvalResult[] = [];
  for (const d of accountDirs(ws)) {
    const p = paths.brief(ws, d);
    if (!existsSync(p)) continue;
    const { body } = parseDoc(readFileSync(p, "utf8"));
    let units = 0;
    let cited = 0;
    const failures: string[] = [];
    for (const sec of SECTIONS) {
      const m = new RegExp(`^##\\s+${sec.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m").exec(body);
      if (!m) continue;
      const blocks = m[1]!
        .split(/\n\s*\n|\n(?=\s*[-*] )/)
        .map((b) => b.trim())
        .filter((b) => b && !b.startsWith("_") && !b.startsWith("[^") && b.replace(/[^a-zA-Z]/g, "").length > 25);
      for (const b of blocks) {
        // Reported absences ("not found after …", "unknown", caveats) are research results, not claims needing a source.
        if (NEGATIVE_FINDING.test(b)) continue;
        units++;
        if (/\[\^[^\]]+\]/.test(b)) cited++;
        else failures.push(`${sec}: "${b.slice(0, 90)}"`);
      }
    }
    out.push({ key: "brief_grounding", target: `accounts/${d}/brief.md`, score: units ? cited / units : null, comment: `${cited}/${units} statements cite a source`, failures });
  }
  return out;
}

/** handoff_completeness: stage contracts hold, and the open-question agenda is being worked. */
export async function handoffCompleteness(ws: string): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const d of accountDirs(ws)) {
    const company = parseDoc<Company>(readFileSync(paths.company(ws, d), "utf8")).data;
    for (const [icp, st] of Object.entries(company.icp_status ?? {})) {
      if (st.stage === "excluded") continue;
      const failures: string[] = [];
      const reached = STAGE_ORDER.indexOf(st.stage);
      const due = CONTRACTS.filter((c) => STAGE_ORDER.indexOf(c.stage) <= reached);
      let checks = due.length;
      for (const c of due) for (const e of await c.check(ws, d, icp, company)) failures.push(`[${c.stage}] ${e}`);
      // researched or later: open questions should be answered or explicitly marked unknown
      const brief = paths.brief(ws, d);
      if (existsSync(brief) && ["researched", "scored", "outreach_ready"].includes(st.stage)) {
        const oq = /^##\s+Open questions\s*$([\s\S]*?)(?=^##\s)/m.exec(parseDoc(readFileSync(brief, "utf8")).body)?.[1] ?? "";
        const open = [...oq.matchAll(/^\s*-\s*\[ \](.*)$/gm)].filter((m) => !/unknown after research|owner:\s*(call-prep|human|discover)/i.test(m[1]!));
        checks++;
        if (open.length) failures.push(`${open.length} open question(s) neither answered nor marked unknown after research`);
      }
      out.push({ key: "handoff_completeness", target: `accounts/${d} (${icp}, ${st.stage})`, score: checks ? (checks - failures.length) / checks : null, comment: failures.length ? `${failures.length} problem(s)` : "all contracts hold", failures });
    }
  }
  return out;
}

const BANNED = [
  "i hope this (email|message) finds you well", "just checking in", "just following up", "touch base", "circle back", "synergy",
  "game[- ]changer", "revolutionary", "cutting[- ]edge", "quick call", "pick your brain", "i wanted to reach out",
];

/** draft_rules: length per channel, cited fact, no clichés, numbers must be traceable to the cited sources/brief. */
export function draftRules(ws: string): EvalResult[] {
  const out: EvalResult[] = [];
  for (const d of accountDirs(ws)) {
    const ddir = join(ws, "accounts", d, "drafts");
    if (!existsSync(ddir)) continue;
    const briefText = existsSync(paths.brief(ws, d)) ? readFileSync(paths.brief(ws, d), "utf8") : "";
    for (const f of readdirSync(ddir).filter((x) => x.endsWith(".md"))) {
      const { data, body } = parseDoc<Draft>(readFileSync(join(ddir, f), "utf8"));
      const message = body.split(/^\[\^/m)[0]!.replace(/\*\*Subject:\*\*.*$/m, "").replace(/\[\^[^\]]+\]/g, "").trim();
      const words = message.split(/\s+/).filter(Boolean).length;
      const failures: string[] = [];
      let checks = 0;
      const check = (ok: boolean, msg: string) => {
        checks++;
        if (!ok) failures.push(msg);
      };
      if (data.channel === "email") check(words <= 120, `email is ${words} words (max 120)`);
      if (data.channel === "linkedin_connect") check(message.length <= 300, `connection note is ${message.length} characters (max 300)`);
      if (data.channel === "linkedin_dm") check(words <= 90, `DM is ${words} words (max 90)`);
      if (data.channel !== "intro_request") check(/\[\^[^\]]+\]/.test(body), "no cited fact about the prospect");
      const low = message.toLowerCase();
      for (const b of BANNED) check(!new RegExp(b).test(low), `cliché: /${b}/`);
      // every number in the message should exist in the brief or a footnote (no invented figures)
      const sources = `${briefText}\n${body}`;
      for (const raw of message.match(/\d+(?:[.,]\d+)*(?:\s?(?:%|(?:k|m|bn|million|billion)\b))?/gi) ?? []) {
        const n = raw.trim();
        if (/^(19|20)\d{2}$/.test(n)) continue; // years
        check(sources.split(n).length > 2 || briefText.includes(n), `number "${n}" not found in the brief or sources`);
      }
      check((message.match(/\?/g) ?? []).length <= 2, "more than two questions — one clear ask works better");
      out.push({ key: "draft_rules", target: `accounts/${d}/drafts/${f}`, score: checks ? (checks - failures.length) / checks : null, comment: `${data.channel}, ${words} words`, failures });
    }
  }
  return out;
}

/**
 * snapshot_coverage: share of URLs cited in a brief that have a stored raw snapshot. Without one, nobody can
 * later verify the claim (and LLM claim-support checks can't run) — typically facts taken from web search
 * results whose page was never saved.
 */
export function snapshotCoverage(ws: string): EvalResult[] {
  const stored = new Set<string>();
  const root = join(ws, "raw");
  for (const month of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, month);
    for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".md")) : []) {
      const url = /^url:\s*(\S+)/m.exec(readFileSync(join(dir, f), "utf8"))?.[1];
      if (url) stored.add(url.replace(/\/$/, ""));
    }
  }
  const out: EvalResult[] = [];
  for (const d of accountDirs(ws)) {
    const p = paths.brief(ws, d);
    if (!existsSync(p)) continue;
    const body = parseDoc(readFileSync(p, "utf8")).body;
    const urls = new Set<string>();
    for (const m of body.matchAll(/^\[\^[^\]]+\]:.*?(https?:\/\/[^\s)]+)/gm)) urls.add(m[1]!.replace(/[).,;]+$/, "").replace(/\/$/, ""));
    if (!urls.size) continue;
    const missing = [...urls].filter((u) => !stored.has(u));
    out.push({ key: "snapshot_coverage", target: `accounts/${d}/brief.md`, score: (urls.size - missing.length) / urls.size, comment: `${urls.size - missing.length}/${urls.size} cited URLs have a stored snapshot`, failures: missing.map((u) => `no snapshot for ${u}`) });
  }
  return out;
}

/** research_trajectory: cheapest-first and on-budget, from the ledger (requires runs to record ops). */
export function researchTrajectory(ws: string): EvalResult[] {
  const byRun = new Map<string, { op: string; usd: number }[]>();
  for (const e of readLedger(ws)) {
    if (!e.run_id || e.provider === "anthropic") continue;
    (byRun.get(e.run_id) ?? byRun.set(e.run_id, []).get(e.run_id)!).push({ op: e.op, usd: e.usd });
  }
  const out: EvalResult[] = [];
  for (const [run, ops] of byRun) {
    if (!run.includes("research")) continue;
    const firstDeep = ops.findIndex((o) => o.op === "research");
    const cheapBefore = firstDeep < 0 ? true : ops.slice(0, firstDeep).some((o) => ["fetch_pages", "search_news", "extract", "find_people"].includes(o.op));
    const deepShare = ops.reduce((a, o) => a + (o.op === "research" ? o.usd : 0), 0) / Math.max(1e-9, ops.reduce((a, o) => a + o.usd, 0));
    const failures: string[] = [];
    if (!cheapBefore) failures.push("deep research agent called before any cheaper lookup");
    if (deepShare > 0.8) failures.push(`deep research agent is ${Math.round(deepShare * 100)}% of provider spend`);
    out.push({ key: "research_trajectory", target: `run ${run}`, score: (2 - failures.length) / 2, comment: `${ops.length} provider calls`, failures });
  }
  return out;
}

export async function runOffline(ws: string): Promise<SuiteResult> {
  const results = [...citationFaithfulness(ws), ...briefGrounding(ws), ...snapshotCoverage(ws), ...(await handoffCompleteness(ws)), ...draftRules(ws), ...researchTrajectory(ws)];
  return { suite: "offline", workspace: ws, ran_at: new Date().toISOString(), results, summary: summarize(results), cost_usd: 0 };
}

export const BRIEF_SECTION_NAMES = BRIEF_SECTIONS;
