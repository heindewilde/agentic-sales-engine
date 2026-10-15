import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS, canTransition } from "./contracts.ts";
import { openDb } from "./db.ts";
import { readDoc, stringifyDoc } from "./frontmatter.ts";
import { readWarmMatches } from "./importers.ts";
import type { Company, Icp, Person, Signal, Stage } from "./schemas.ts";
import { paths, today } from "./workspace.ts";

/** Move an account's stage forward only when the target stage's handoff contract (and all earlier ones) hold. */
export async function advanceStage(ws: string, domain: string, icp: string, to: Stage, reason?: string) {
  const p = paths.company(ws, domain);
  if (!existsSync(p)) throw new Error(`accounts/${domain}/company.md not found`);
  const { data, body } = await readDoc<Company>(p);
  const st = data.icp_status?.[icp];
  if (!st) throw new Error(`${domain} is not in ICP ${icp}`);
  if (!canTransition(st.stage, to)) throw new Error(`cannot move ${domain} from ${st.stage} back to ${to}`);
  if (to === "excluded") {
    st.stage = "excluded";
    st.excluded_reason = reason ?? "excluded";
  } else {
    const errors: string[] = [];
    const target = CONTRACTS.findIndex((c) => c.stage === to);
    const probe: Company = { ...data, icp_status: { ...data.icp_status, [icp]: { ...st, stage: to } } };
    for (const c of CONTRACTS.slice(0, target + 1)) {
      for (const e of await c.check(ws, domain, icp, probe)) errors.push(`[${c.stage}] ${e}`);
    }
    if (errors.length) return { domain, icp, stage: st.stage, advanced: false, errors };
    st.stage = to;
  }
  st.updated = today();
  writeFileSync(p, stringifyDoc(data, body));
  return { domain, icp, stage: st.stage, advanced: true, errors: [] as string[] };
}

export interface WarmPath {
  member: string;
  person: string;
  linkedin_url: string | null;
  position: string;
  persona: string | null;
  connected_on: string | null;
  years_connected: number | null;
  /** 3 = direct to a target persona, 2 = can introduce (same company, other role), per the methodology */
  strength: 2 | 3;
  quality: "exact" | "prefix";
}

/** Match a job title to an ICP persona by its listed titles (case-insensitive substring either way). */
export function personaFor(title: string, icp: Pick<Icp, "personas"> | null): string | null {
  const t = title.toLowerCase();
  for (const p of icp?.personas ?? []) {
    if (p.titles.some((x) => t.includes(x.toLowerCase()) || (t.length > 3 && x.toLowerCase().includes(t)))) return p.name;
  }
  return null;
}

/**
 * Deterministic inputs for the ways-in stage: warm paths (team connections at the account, ranked),
 * recent dated signals relevant to the ICP, and known people with their persona. The skill turns these
 * into ranked, written ways in.
 */
export async function waysIn(ws: string, domain: string, icpSlug: string) {
  const icpPath = paths.icp(ws, icpSlug);
  const icp = existsSync(icpPath) ? (await readDoc<Icp>(icpPath)).data : null;
  const now = Date.now();
  const warm: WarmPath[] = readWarmMatches(ws)
    .filter((m) => m.account === domain)
    .map((m) => {
      const persona = personaFor(m.position, icp);
      const years = m.connected_on ? Math.round(((now - Date.parse(m.connected_on)) / (365.25 * 86_400_000)) * 10) / 10 : null;
      return {
        member: m.member, person: m.name, linkedin_url: m.linkedin_url, position: m.position, persona,
        connected_on: m.connected_on, years_connected: years, strength: (persona ? 3 : 2) as 2 | 3, quality: m.quality,
      };
    })
    .sort((a, b) => b.strength - a.strength || (a.quality === "exact" ? -1 : 1) || (a.years_connected ?? 99) - (b.years_connected ?? 99));

  const signals: (Signal & { path: string; age_days: number })[] = [];
  const sdir = join(ws, "accounts", domain, "signals");
  for (const f of existsSync(sdir) ? readdirSync(sdir).filter((x) => x.endsWith(".md")) : []) {
    const { data } = await readDoc<Signal>(join(sdir, f));
    const age = Math.round((now - Date.parse(data.date)) / 86_400_000);
    if (age <= 365 && data.status !== "stale") signals.push({ ...data, path: `accounts/${domain}/signals/${f}`, age_days: age });
  }
  signals.sort((a, b) => (b.relevance?.[icpSlug] ?? 0) - (a.relevance?.[icpSlug] ?? 0) || a.age_days - b.age_days);

  const people: { id: string; name: string; title: string | null; persona: string | null; known_by: string[] }[] = [];
  const pdir = join(ws, "people");
  for (const f of existsSync(pdir) ? readdirSync(pdir).filter((x) => x.endsWith(".md")) : []) {
    const { data } = await readDoc<Person>(join(pdir, f));
    if (data.company !== domain || data.dnc) continue;
    const title = (data.facts?.title?.value as string | undefined) ?? null;
    people.push({ id: data.id, name: data.name, title, persona: data.persona ?? (title ? personaFor(title, icp) : null), known_by: (data.known_by ?? []).map((k) => k.member) });
  }
  const best = warm[0];
  return {
    domain,
    icp: icpSlug,
    warm_paths: warm,
    signals: signals.map((s) => ({ type: s.type, title: s.title, date: s.date, age_days: s.age_days, relevance: s.relevance?.[icpSlug] ?? null, source_url: s.source_url, path: s.path })),
    people,
    suggested_warm_path_level: best ? best.strength : 0,
    personas_without_named_person: (icp?.personas ?? []).map((p) => p.name).filter((n) => !people.some((p) => p.persona === n)),
  };
}

/** Facts past their TTL, grouped by account, for shortlisted-and-later accounts first. */
export async function staleFacts(ws: string, opts: { icp?: string; limit?: number } = {}) {
  const db = openDb(ws);
  try {
    const rows = db
      .query(
        `SELECT f.entity_type, f.entity_id, f.field, f.source_url, f.expires_at, f.path, ai.stage
         FROM facts f LEFT JOIN account_icp ai ON ai.domain = f.entity_id ${opts.icp ? "AND ai.icp = $icp" : ""}
         WHERE f.expires_at < date('now') ORDER BY
           CASE ai.stage WHEN 'outreach_ready' THEN 0 WHEN 'scored' THEN 1 WHEN 'researched' THEN 2 WHEN 'shortlisted' THEN 3 ELSE 4 END,
           f.expires_at`,
      )
      .all(opts.icp ? { $icp: opts.icp } : {}) as { entity_type: string; entity_id: string; field: string; source_url: string; expires_at: string; path: string; stage: string | null }[];
    const grouped = new Map<string, { entity: string; stage: string | null; facts: { field: string; source_url: string; expired: string; path: string }[] }>();
    for (const r of rows) {
      const key = `${r.entity_type}:${r.entity_id}`;
      const g = grouped.get(key) ?? { entity: key, stage: r.stage, facts: [] };
      if (!g.facts.some((f) => f.field === r.field && f.path === r.path)) g.facts.push({ field: r.field, source_url: r.source_url, expired: r.expires_at, path: r.path });
      grouped.set(key, g);
    }
    const all = [...grouped.values()];
    return { entities: all.length, facts: rows.length, items: opts.limit ? all.slice(0, opts.limit) : all };
  } finally {
    db.close();
  }
}
