import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import type { Candidate } from "./accounts.ts";
import { parseYaml, readDoc, stringifyYaml } from "./frontmatter.ts";
import { normalizeDomain, normalizeLinkedIn, personId } from "./normalize.ts";
import type { Company } from "./schemas.ts";
import { paths } from "./workspace.ts";

// ---------- seed lists (Apollo, Sales Navigator exports, trade-fair exhibitor lists, ...) ----------

const COLUMN_ALIASES: Record<keyof Omit<Candidate, "source_url" | "confidence" | "method" | "raw_ref">, string[]> = {
  name: ["company", "company name", "name", "account name", "organization", "organisation", "company_name", "exhibitor", "firma", "bedrijf"],
  domain: ["domain", "website", "company website", "url", "web", "website url", "company domain", "site", "homepage"],
  url: [],
  description: ["description", "short description", "about", "company description", "keywords"],
  employees: ["employees", "# employees", "employee count", "headcount", "company size", "size", "staff", "number of employees"],
  hq_country: ["country", "company country", "hq country", "headquarters country", "land"],
  hq_city: ["city", "company city", "hq city", "headquarters city"],
  industry: ["industry", "sector", "industries", "category", "branche"],
  founded: ["founded", "founded year", "year founded"],
  linkedin_url: ["linkedin", "company linkedin url", "linkedin url", "company linkedin"],
};

/** Map CSV headers to candidate fields (case/punctuation-insensitive). Explicit overrides win. */
export function detectColumns(headers: string[], overrides: Record<string, string> = {}): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  const map: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const hit = headers.find((h) => aliases.includes(norm(h)));
    if (hit) map[field] = hit;
  }
  return { ...map, ...overrides };
}

export function readSeedCsv(ws: string, file: string, overrides: Record<string, string> = {}): { candidates: Candidate[]; columns: Record<string, string>; rows: number } {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  const delimiter = (text.split("\n")[0] ?? "").split(";").length > (text.split("\n")[0] ?? "").split(",").length ? ";" : ",";
  const rows = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, delimiter, relax_column_count: true }) as Record<string, string>[];
  const columns = detectColumns(Object.keys(rows[0] ?? {}), overrides);
  if (!columns.name && !columns.domain) throw new Error(`could not find a company name or website column in ${basename(file)} (headers: ${Object.keys(rows[0] ?? {}).join(", ")}); pass --map name=<col> --map domain=<col>`);
  const rel = file.startsWith(ws) ? file.slice(ws.length + 1) : `imports/seeds/${basename(file)}`;
  const get = (r: Record<string, string>, f: string) => (columns[f] ? (r[columns[f]!] ?? "").trim() : "");
  const candidates = rows.map((r) => {
    const site = get(r, "domain");
    const emp = get(r, "employees");
    return {
      name: get(r, "name") || normalizeDomain(site) || "",
      domain: normalizeDomain(site),
      url: site && /^https?:\/\//.test(site) ? site : site ? `https://${normalizeDomain(site) ?? site}` : null,
      description: get(r, "description") || null,
      employees: emp ? (/^\d+$/.test(emp) ? Number(emp) : emp) : null,
      hq_country: get(r, "hq_country") || null,
      hq_city: get(r, "hq_city") || null,
      industry: get(r, "industry") || null,
      founded: Number(get(r, "founded")) || null,
      linkedin_url: get(r, "linkedin_url") || null,
      source_url: `import:${rel}`,
      confidence: 0.5,
      method: "import" as const,
    } satisfies Candidate;
  });
  return { candidates, columns, rows: rows.length };
}

// ---------- LinkedIn connections (warm intros) ----------

export interface Connection {
  first_name: string;
  last_name: string;
  linkedin_url: string | null;
  company: string;
  position: string;
  connected_on: string | null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "15 Mar 2021" → "2021-03-15" (LinkedIn export format); passes ISO dates through. */
export function parseConnectedOn(s: string | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s.trim());
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return Number.isNaN(Date.parse(s)) ? null : new Date(s).toISOString().slice(0, 10);
}

/** Parse LinkedIn's Connections.csv: skips the "Notes:" preamble before the real header row. Email addresses are dropped. */
export function parseConnections(text: string): Connection[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^"?First Name"?,/i.test(l));
  if (start < 0) throw new Error('not a LinkedIn Connections.csv (no "First Name,Last Name,..." header found)');
  const rows = parseCsv(lines.slice(start).join("\n"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<string, string>[];
  return rows.map((r) => ({
    first_name: r["First Name"] ?? "",
    last_name: r["Last Name"] ?? "",
    linkedin_url: normalizeLinkedIn(r.URL),
    company: r.Company ?? "",
    position: r.Position ?? "",
    connected_on: parseConnectedOn(r["Connected On"]),
  })).filter((c) => c.first_name || c.last_name);
}

/** Company-name key for matching: lowercase, no legal suffixes or punctuation. */
export function companyKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(inc|incorporated|ltd|limited|llc|gmbh|ag|bv|b\.v|nv|n\.v|sa|s\.a|sas|sarl|srl|bvba|plc|oy|ab|as|aps|spa|s\.p\.a|co|corp|corporation|company|group|holding|holdings)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface WarmMatch {
  person_id: string;
  name: string;
  linkedin_url: string | null;
  position: string;
  company_name: string;
  account: string;
  connected_on: string | null;
  quality: "exact" | "prefix";
}

/** Match one member's connections against the workspace's accounts by current-company name. */
export async function matchConnections(ws: string, connections: Connection[]): Promise<WarmMatch[]> {
  const index = new Map<string, string>(); // companyKey -> domain
  const adir = join(ws, "accounts");
  for (const d of existsSync(adir) ? readdirSync(adir) : []) {
    const cp = paths.company(ws, d);
    if (!existsSync(cp)) continue;
    const { data } = await readDoc<Company>(cp);
    for (const n of [data.name, ...(data.aliases ?? [])]) {
      const k = companyKey(n ?? "");
      if (k.length >= 3) index.set(k, d);
    }
    // the domain's label is a useful alias ("brightline-foods.example" → "brightline foods")
    const label = companyKey(d.split(".")[0]!.replace(/-/g, " "));
    if (label.length >= 4 && !index.has(label)) index.set(label, d);
  }
  const keys = [...index.keys()];
  const out: WarmMatch[] = [];
  for (const c of connections) {
    const k = companyKey(c.company);
    if (!k) continue;
    let domain = index.get(k);
    let quality: WarmMatch["quality"] = "exact";
    if (!domain) {
      // word-boundary prefix match either way, only for reasonably distinctive names
      const hit = keys.find((x) => x.length >= 6 && k.length >= 6 && (k.startsWith(`${x} `) || x.startsWith(`${k} `)));
      if (hit) {
        domain = index.get(hit);
        quality = "prefix";
      }
    }
    if (!domain) continue;
    const name = `${c.first_name} ${c.last_name}`.trim();
    out.push({
      person_id: personId(c.linkedin_url, name, domain),
      name,
      linkedin_url: c.linkedin_url,
      position: c.position,
      company_name: c.company,
      account: domain,
      connected_on: c.connected_on,
      quality,
    });
  }
  return out;
}

export const connectionsPath = (ws: string, member: string) => join(ws, "team", member, "connections.csv");
export const warmMatchesPath = (ws: string, member: string) => join(ws, "team", member, "warm-matches.yaml");

/**
 * Import a member's export: keep the raw CSV locally (gitignored), write only matches against tracked
 * accounts to the committed warm-matches.yaml.
 */
export async function importConnections(ws: string, member: string, file: string) {
  const conns = parseConnections(readFileSync(file, "utf8"));
  const dest = connectionsPath(ws, member);
  mkdirSync(dirname(dest), { recursive: true });
  if (file !== dest) copyFileSync(file, dest);
  return { member, connections: conns.length, ...(await rematchMember(ws, member)) };
}

/** Recompute a member's warm matches from their local export (after new accounts were discovered). */
export async function rematchMember(ws: string, member: string) {
  const src = connectionsPath(ws, member);
  if (!existsSync(src)) return { matches: 0, accounts: 0 };
  const matches = await matchConnections(ws, parseConnections(readFileSync(src, "utf8")));
  writeFileSync(
    warmMatchesPath(ws, member),
    `# Generated by \`ase connections match\` from team/${member}/connections.csv (kept local). Only people at tracked accounts.\n` +
      stringifyYaml({ member, matched_at: new Date().toISOString(), matches }),
  );
  return { matches: matches.length, accounts: new Set(matches.map((m) => m.account)).size };
}

export async function rematchAll(ws: string) {
  const tdir = join(ws, "team");
  const out: Record<string, { matches: number; accounts: number }> = {};
  for (const m of existsSync(tdir) ? readdirSync(tdir) : []) {
    if (existsSync(connectionsPath(ws, m))) out[m] = await rematchMember(ws, m);
  }
  return out;
}

export function readWarmMatches(ws: string): (WarmMatch & { member: string })[] {
  const tdir = join(ws, "team");
  const out: (WarmMatch & { member: string })[] = [];
  for (const m of existsSync(tdir) ? readdirSync(tdir) : []) {
    const f = warmMatchesPath(ws, m);
    if (!existsSync(f)) continue;
    const doc = parseYaml<{ matches?: WarmMatch[] }>(readFileSync(f, "utf8")) ?? {};
    for (const x of doc.matches ?? []) out.push({ ...x, member: m });
  }
  return out;
}
