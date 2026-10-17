import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeLinkedIn } from "./normalize.ts";

/** Saved source pages (raw/<yyyy-mm>/*.md): finding them by URL and checking that a quote is really on them. */

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[“”«»"']/g, "").replace(/[^a-z0-9€$%.,]+/g, " ").trim();

/** Does `quote` appear in `text`? Exact after normalization, or ≥ 85% of its words in one window (tolerates "…" and minor reformatting). */
export function quoteSupported(quote: string, text: string): boolean {
  // An elided quote ("A … B") is supported when each of its parts is on the page.
  const parts = quote.split(/\s*(?:…|\.\.\.)\s*/).map((p) => p.trim()).filter((p) => norm(p).split(" ").filter((w) => w.length > 2).length >= 3);
  if (parts.length > 1) return parts.every((p) => segmentSupported(p, text));
  return segmentSupported(quote, text);
}

function segmentSupported(quote: string, text: string): boolean {
  const q = norm(quote.replace(/…|\.\.\./g, " "));
  const t = norm(text);
  if (!q) return false;
  if (t.includes(q)) return true;
  // Content words, numbers included however short. Reformatting may cost a word or two; an added detail may not:
  // every number must be on the page, and at most max(1, 10%) of the other words may be missing.
  const qw = q.split(" ").filter((w) => w.length > 2 || /\d/.test(w));
  if (qw.length < 3) return false;
  const nums = qw.filter((w) => /\d/.test(w));
  const words = qw.filter((w) => !/\d/.test(w));
  const allowMissing = Math.max(1, Math.floor(words.length * 0.1));
  const tw = t.split(" ");
  const span = Math.round(qw.length * 1.6) + 2;
  for (let i = 0; i < tw.length; i++) {
    const win = new Set(tw.slice(i, i + span));
    if (!nums.every((n) => win.has(n))) continue;
    const missing = words.filter((w) => !win.has(w)).length;
    if (missing <= allowMissing) return true;
  }
  return false;
}

/** Same page, different spelling: LinkedIn locale subdomains, www., trailing slash. */
export function canonicalUrl(u: string): string {
  return normalizeLinkedIn(u) ?? u.replace(/^https?:\/\/www\./, "https://").replace(/\/$/, "");
}

/** Every saved snapshot in the workspace by canonical URL (a URL can have several snapshots over time). */
export function snapshotIndex(ws: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const root = join(ws, "raw");
  for (const month of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, month);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const rel = `raw/${month}/${f}`;
      const url = /^url:\s*(\S+)/m.exec(readFileSync(join(ws, rel), "utf8"))?.[1];
      if (url) (idx.get(canonicalUrl(url)) ?? idx.set(canonicalUrl(url), []).get(canonicalUrl(url))!).push(rel);
    }
  }
  return idx;
}

/** Find the saved page that carries `quote` for `url` (or check the given raw_ref). Returns its raw_ref, or null. */
export function findQuote(ws: string, quote: string, url: string, rawRef?: string, idx?: Map<string, string[]>): string | null {
  const candidates = rawRef ? [rawRef] : (idx ?? snapshotIndex(ws)).get(canonicalUrl(url)) ?? [];
  for (const rel of candidates) {
    const p = join(ws, rel);
    if (existsSync(p) && quoteSupported(quote, readFileSync(p, "utf8"))) return rel;
  }
  return null;
}
