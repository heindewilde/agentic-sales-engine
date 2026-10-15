import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDoc } from "./frontmatter.ts";
import { classify } from "./validate.ts";
import { paths, relPath } from "./workspace.ts";
import type { Company, Fact, Person, ScoreFile, Signal } from "./schemas.ts";

/**
 * The SQLite index is derived state: every table is rebuilt from workspace files
 * (markdown + ledger jsonl + outcomes csv). Never edit it by hand; delete it and run `reindex`.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts(domain TEXT PRIMARY KEY, name TEXT, owner TEXT, dnc INTEGER, hq_country TEXT, employees TEXT, industry TEXT, path TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS account_icp(domain TEXT, icp TEXT, stage TEXT, light_score REAL, score REAL, upside REAL, coverage REAL, tier TEXT, scoring_version INTEGER, run_id TEXT, updated TEXT, PRIMARY KEY(domain, icp));
CREATE TABLE IF NOT EXISTS facts(entity_type TEXT, entity_id TEXT, field TEXT, value_json TEXT, source_url TEXT, retrieved_at TEXT, confidence REAL, ttl_days INTEGER, expires_at TEXT, path TEXT);
CREATE INDEX IF NOT EXISTS facts_entity ON facts(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS facts_expiry ON facts(expires_at);
CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, linkedin_url TEXT, name TEXT, company_domain TEXT, title TEXT, persona TEXT, dnc INTEGER, path TEXT);
CREATE INDEX IF NOT EXISTS people_company ON people(company_domain);
CREATE TABLE IF NOT EXISTS warm_paths(member TEXT, person_id TEXT, company_domain TEXT, via TEXT, connected_on TEXT);
CREATE TABLE IF NOT EXISTS signals(path TEXT PRIMARY KEY, domain TEXT, type TEXT, title TEXT, date TEXT, source_url TEXT, status TEXT, relevance_json TEXT);
CREATE TABLE IF NOT EXISTS factor_scores(domain TEXT, icp TEXT, version INTEGER, mode TEXT, factor_id TEXT, level INTEGER, confidence REAL, evidence_count INTEGER);
CREATE TABLE IF NOT EXISTS fts_docs(path TEXT PRIMARY KEY, kind TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, body);
`;

export function openDb(ws: string): Database {
  const p = paths.db(ws);
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

function expiresAt(f: Fact, defaultTtl: number): string | null {
  const ttl = f.ttl_days ?? defaultTtl;
  const t = Date.parse(f.retrieved_at);
  if (Number.isNaN(t)) return null;
  return new Date(t + ttl * 86_400_000).toISOString().slice(0, 10);
}

function factValue(f: Fact | undefined): string | null {
  if (!f) return null;
  return typeof f.value === "string" ? f.value : JSON.stringify(f.value);
}

/** Remove everything indexed from one file. */
function forget(db: Database, rel: string): void {
  const c = classify(rel);
  db.run("DELETE FROM facts WHERE path = ?", [rel]);
  db.run("DELETE FROM fts WHERE path = ?", [rel]);
  db.run("DELETE FROM fts_docs WHERE path = ?", [rel]);
  if (c.kind === "company" && c.account) {
    db.run("DELETE FROM accounts WHERE domain = ?", [c.account]);
    db.run("DELETE FROM account_icp WHERE domain = ?", [c.account]);
  } else if (c.kind === "person") {
    db.run("DELETE FROM warm_paths WHERE person_id IN (SELECT id FROM people WHERE path = ?)", [rel]);
    db.run("DELETE FROM people WHERE path = ?", [rel]);
  } else if (c.kind === "signal") {
    db.run("DELETE FROM signals WHERE path = ?", [rel]);
  } else if (c.kind === "score" && c.account && c.icp) {
    db.run("DELETE FROM factor_scores WHERE domain = ? AND icp = ?", [c.account, c.icp]);
  }
}

/** (Re)index a single workspace file. Missing files are removed from the index. Invalid files are skipped (lint reports them). */
export async function indexFile(db: Database, ws: string, absOrRel: string, defaultTtl = 120): Promise<void> {
  const rel = relPath(ws, absOrRel);
  if (!rel || !rel.endsWith(".md") || rel.startsWith(".ase/")) return;
  const abs = join(ws, rel);
  const c = classify(rel);
  const tx = db.transaction(() => forget(db, rel));
  tx();
  if (!existsSync(abs)) return;
  let data: Record<string, unknown>;
  let body: string;
  try {
    ({ data, body } = parseDoc(await Bun.file(abs).text()));
  } catch {
    return;
  }

  const insertFacts = (type: string, id: string, facts: Record<string, Fact> | undefined) => {
    for (const [field, f] of Object.entries(facts ?? {})) {
      if (!f || typeof f !== "object") continue;
      db.run(
        "INSERT INTO facts VALUES (?,?,?,?,?,?,?,?,?,?)",
        [type, id, field, JSON.stringify(f.value ?? null), f.source_url ?? null, f.retrieved_at ?? null, f.confidence ?? null, f.ttl_days ?? null, expiresAt(f, defaultTtl), rel],
      );
    }
  };

  db.transaction(() => {
    if (c.kind === "company" && c.account) {
      const co = data as unknown as Company;
      db.run("INSERT OR REPLACE INTO accounts VALUES (?,?,?,?,?,?,?,?,?)", [
        c.account, co.name ?? c.account, co.owner ?? null, co.dnc ? 1 : 0,
        factValue(co.facts?.hq_country), factValue(co.facts?.employees), factValue(co.facts?.industry), rel,
        new Date().toISOString(),
      ]);
      for (const [icp, s] of Object.entries(co.icp_status ?? {})) {
        db.run("INSERT OR REPLACE INTO account_icp VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
          c.account, icp, s.stage, s.light_score ?? null, s.score ?? null, s.upside ?? null, s.coverage ?? null,
          s.tier ?? null, s.scoring_version ?? null, s.run_id ?? null, s.updated,
        ]);
      }
      insertFacts("company", c.account, co.facts);
    } else if (c.kind === "person") {
      const p = data as unknown as Person;
      db.run("INSERT OR REPLACE INTO people VALUES (?,?,?,?,?,?,?,?)", [
        p.id, p.linkedin_url ?? null, p.name, p.company ?? null, factValue(p.facts?.title), p.persona ?? null, p.dnc ? 1 : 0, rel,
      ]);
      for (const k of p.known_by ?? []) {
        db.run("INSERT INTO warm_paths VALUES (?,?,?,?,?)", [k.member, p.id, p.company ?? null, k.via ?? "linkedin_connections", k.connected_on ?? null]);
      }
      insertFacts("person", p.id, p.facts);
    } else if (c.kind === "signal" && c.account) {
      const s = data as unknown as Signal;
      db.run("INSERT OR REPLACE INTO signals VALUES (?,?,?,?,?,?,?,?)", [
        rel, c.account, s.type, s.title, s.date, s.source_url, s.status ?? "new", JSON.stringify(s.relevance ?? {}),
      ]);
    } else if (c.kind === "score" && c.account && c.icp) {
      const s = data as unknown as ScoreFile;
      for (const f of s.factors ?? []) {
        db.run("INSERT INTO factor_scores VALUES (?,?,?,?,?,?,?,?)", [
          c.account, c.icp, s.scoring_version, s.mode, f.id, f.level, f.confidence, f.evidence?.length ?? 0,
        ]);
      }
    }
    db.run("INSERT INTO fts(path, body) VALUES (?, ?)", [rel, `${JSON.stringify(data)}\n${body}`]);
    db.run("INSERT OR REPLACE INTO fts_docs VALUES (?, ?)", [rel, c.kind]);
  })();
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Drop and rebuild the whole index from files. */
export async function reindexAll(ws: string, defaultTtl = 120): Promise<{ files: number }> {
  const db = openDb(ws);
  try {
    db.exec(
      "DELETE FROM accounts; DELETE FROM account_icp; DELETE FROM facts; DELETE FROM people; DELETE FROM warm_paths; DELETE FROM signals; DELETE FROM factor_scores; DELETE FROM fts; DELETE FROM fts_docs;",
    );
    const files = [...walk(join(ws, "accounts")), ...walk(join(ws, "people")), ...walk(join(ws, "icps"))];
    for (const f of files) await indexFile(db, ws, f, defaultTtl);
    return { files: files.length };
  } finally {
    db.close();
  }
}

