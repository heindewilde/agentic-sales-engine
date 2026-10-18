import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseYaml, readDoc, stringifyDoc, stringifyYaml } from "./frontmatter.ts";
import { normalizeDomain } from "./normalize.ts";
import { callProvider, type GatewayOptions } from "./providers/gateway.ts";
import { estimate } from "./providers/pricing.ts";
import { ProviderError } from "./providers/types.ts";
import { Watchlist, type Company, type Signal, type WatchEntry } from "./schemas.ts";
import { paths, today } from "./workspace.ts";

/**
 * Signal monitoring by polling. Each watched account gets (a) a dated news search since the last check
 * and (b) a content hash of chosen pages (careers, team, news) — a changed hash produces a diff. New items
 * land in sync/<date>.md for the refresh skill to judge: real trigger → signal file + rescore; noise → dropped.
 * Polling instead of provider-side monitors: no webhook endpoint needed, works with any configured provider.
 */

export const watchlistPath = (ws: string) => join(ws, "watchlist.yaml");
const SEEN_CAP = 200;
const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export function loadWatchlist(ws: string): Watchlist {
  const p = watchlistPath(ws);
  if (!existsSync(p)) return { entries: [] };
  return Watchlist.parse(parseYaml(readFileSync(p, "utf8")) ?? {});
}

export function saveWatchlist(ws: string, wl: Watchlist): void {
  writeFileSync(watchlistPath(ws), `# Accounts monitored by \`ase sync\` / the refresh skill. Edit freely.\n${stringifyYaml(wl)}`);
}

export async function addWatch(ws: string, domainRaw: string, icp: string, opts: { pages?: string[]; news_query?: string; by?: string } = {}) {
  const domain = normalizeDomain(domainRaw) ?? domainRaw;
  if (!existsSync(paths.company(ws, domain))) throw new Error(`accounts/${domain} does not exist — discover or import it first`);
  const wl = loadWatchlist(ws);
  let e = wl.entries.find((x) => x.account === domain && x.icp === icp);
  if (!e) {
    e = { account: domain, icp, news: true, pages: [], page_hashes: {}, seen: [], added: today(), added_by: opts.by };
    wl.entries.push(e);
  }
  for (const p of opts.pages ?? []) if (!e.pages.includes(p)) e.pages.push(p);
  if (opts.news_query) e.news_query = opts.news_query;
  saveWatchlist(ws, wl);
  return e;
}

export function removeWatch(ws: string, domain: string, icp?: string) {
  const wl = loadWatchlist(ws);
  const before = wl.entries.length;
  wl.entries = wl.entries.filter((e) => !(e.account === domain && (!icp || e.icp === icp)));
  saveWatchlist(ws, wl);
  return { removed: before - wl.entries.length };
}

/** Normalize page text before hashing so dates, counters and whitespace don't trigger false changes. */
export function normalizePage(text: string): string {
  return text
    .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, "")
    .replace(/\b(19|20)\d{2}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/** Lines added/removed between two texts (multiset diff — order-insensitive, good enough for job lists). */
export function lineDiff(before: string, after: string, cap = 40): { added: string[]; removed: string[] } {
  const count = (t: string) => {
    const m = new Map<string, number>();
    for (const l of t.split("\n")) if (l.trim()) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) ?? 0); i++) added.push(l);
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) ?? 0); i++) removed.push(l);
  return { added: added.slice(0, cap), removed: removed.slice(0, cap) };
}

export interface SyncItem {
  account: string;
  icp: string;
  kind: "news" | "page_change" | "page_baseline";
  title: string;
  url: string;
  published?: string | null;
  summary?: string | null;
  added?: string[];
  removed?: string[];
  raw_ref?: string | null;
}

export interface SyncResult {
  run_file: string | null;
  checked: number;
  items: SyncItem[];
  stale_signals: string[];
  cost_usd: number;
  errors: { account: string; error: string }[];
  stopped: string | null;
}

/** Estimated cost of one sync pass (for the budget prompt). */
export function estimateSync(wl: Watchlist, icp?: string): number {
  let usd = 0;
  for (const e of wl.entries.filter((x) => !icp || x.icp === icp)) {
    if (e.news) usd += estimate("exa", "search_news", { query: "x", since: today(), num_results: 5 });
    if (e.pages.length) usd += estimate("firecrawl", "fetch_pages", { urls: e.pages });
  }
  return Math.round(usd * 1000) / 1000;
}

/** Mark signals past their TTL as stale (deterministic, no provider calls). */
export async function markStaleSignals(ws: string): Promise<string[]> {
  const out: string[] = [];
  const adir = join(ws, "accounts");
  for (const d of existsSync(adir) ? readdirSync(adir) : []) {
    const sdir = join(adir, d, "signals");
    if (!existsSync(sdir)) continue;
    for (const f of readdirSync(sdir).filter((x) => x.endsWith(".md"))) {
      const p = join(sdir, f);
      const { data, body } = await readDoc<Signal>(p);
      const age = (Date.now() - Date.parse(data.date)) / 86_400_000;
      if (data.status !== "stale" && age > (data.ttl_days ?? 90)) {
        data.status = "stale";
        writeFileSync(p, stringifyDoc(data, body));
        out.push(`accounts/${d}/signals/${f}`);
      }
    }
  }
  return out;
}

export async function runSync(ws: string, opts: { icp?: string; account?: string; sinceDays?: number; gateway?: Omit<GatewayOptions, "ws"> } = {}): Promise<SyncResult> {
  const wl = loadWatchlist(ws);
  const res: SyncResult = { run_file: null, checked: 0, items: [], stale_signals: [], cost_usd: 0, errors: [], stopped: null };
  const g = { ws, ...(opts.gateway ?? {}) };
  for (const e of wl.entries) {
    if ((opts.icp && e.icp !== opts.icp) || (opts.account && e.account !== opts.account)) continue;
    if (res.stopped) break;
    const cp = paths.company(ws, e.account);
    if (!existsSync(cp)) continue;
    const company = (await readDoc<Company>(cp)).data;
    if (company.dnc) continue;
    res.checked++;
    try {
      if (e.news) {
        const since = e.last_news_check ?? new Date(Date.now() - (opts.sinceDays ?? 90) * 86_400_000).toISOString().slice(0, 10);
        const query = `"${company.name}"${e.news_query ? ` ${e.news_query}` : ""}`;
        const r = await callProvider("search_news", { query, since, num_results: 5 }, g);
        res.cost_usd += r.cost_usd;
        for (const n of r.results as (typeof r.results[number] & { raw_ref?: string })[]) {
          const h = short(n.url);
          if (e.seen.includes(h)) continue;
          e.seen.push(h);
          res.items.push({ account: e.account, icp: e.icp, kind: "news", title: n.title, url: n.url, published: n.published, summary: n.summary, raw_ref: n.raw_ref ?? null });
        }
        e.seen = e.seen.slice(-SEEN_CAP);
        e.last_news_check = today();
      }
      if (e.pages.length) {
        const r = await callProvider("fetch_pages", { urls: e.pages, max_chars: 20_000 }, g);
        res.cost_usd += r.cost_usd;
        for (const page of r.results as (typeof r.results[number] & { raw_ref?: string })[]) {
          const norm = normalizePage(page.text);
          const h = short(norm);
          const prev = e.page_hashes[page.url];
          if (prev === h) continue;
          if (!prev) {
            res.items.push({ account: e.account, icp: e.icp, kind: "page_baseline", title: `Baseline captured: ${page.title ?? page.url}`, url: page.url, raw_ref: page.raw_ref ?? null });
          } else {
            // Compare against the previous snapshot text kept in .ase (local cache) when available.
            const cacheDir = join(ws, ".ase", "pages");
            const prevFile = join(cacheDir, `${prev}.txt`);
            const diff = existsSync(prevFile) ? lineDiff(readFileSync(prevFile, "utf8"), norm) : { added: [], removed: [] };
            res.items.push({ account: e.account, icp: e.icp, kind: "page_change", title: `Changed: ${page.title ?? page.url}`, url: page.url, added: diff.added, removed: diff.removed, raw_ref: page.raw_ref ?? null });
          }
          mkdirSync(join(ws, ".ase", "pages"), { recursive: true });
          writeFileSync(join(ws, ".ase", "pages", `${h}.txt`), norm);
          e.page_hashes[page.url] = h;
        }
      }
    } catch (err) {
      if (err instanceof ProviderError && err.code === "budget") {
        res.stopped = err.message;
        break;
      }
      res.errors.push({ account: e.account, error: (err as Error).message });
    }
  }
  saveWatchlist(ws, wl);
  res.stale_signals = await markStaleSignals(ws);

  const actionable = res.items.filter((i) => i.kind !== "page_baseline");
  if (res.items.length) {
    const rel = `sync/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const lines = res.items.map((i, n) => {
      const head = `### ${n + 1}. [${i.kind}] ${i.account} — ${i.title}\n- url: ${i.url}${i.published ? `\n- published: ${i.published}` : ""}${i.raw_ref ? `\n- raw_ref: ${i.raw_ref}` : ""}`;
      const sum = i.summary ? `\n- summary: ${i.summary.replace(/\n/g, " ")}` : "";
      const diff = i.kind === "page_change" ? `\n- added:\n${(i.added ?? []).map((l) => `  + ${l}`).join("\n") || "  (none)"}\n- removed:\n${(i.removed ?? []).map((l) => `  - ${l}`).join("\n") || "  (none)"}` : "";
      return `${head}${sum}${diff}\n- decision: _pending_`;
    });
    writeFileSync(
      abs,
      stringifyDoc(
        { synced_at: new Date().toISOString(), checked: res.checked, items: res.items.length, actionable: actionable.length, status: actionable.length ? "pending_review" : "reviewed", cost_usd: Math.round(res.cost_usd * 1000) / 1000 },
        `# Sync ${today()}\n\nItems below are candidates, not facts. The refresh skill turns real trigger events into signal files and drops noise.\n\n${lines.join("\n\n")}\n`,
      ),
    );
    res.run_file = rel;
  }
  return res;
}
