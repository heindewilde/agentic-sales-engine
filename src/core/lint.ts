import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkAccount } from "./contracts.ts";
import { openDb } from "./db.ts";
import { readDoc } from "./frontmatter.ts";
import type { Company } from "./schemas.ts";
import { validateContent } from "./validate.ts";
import { dncMatcher, loadConfig, loadDnc, paths } from "./workspace.ts";

export interface LintIssue {
  kind: "invalid" | "contract" | "stale" | "orphan" | "duplicate" | "dnc" | "open_questions";
  path: string;
  detail: string;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(md|ya?ml)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Mechanical knowledge-base lint. Semantic checks (contradicting claims across sources, outdated
 * narrative) are done by the wiki-linter agent, which starts from this report.
 */
export async function lint(ws: string): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const cfg = await loadConfig(ws).catch(() => null);
  const dnc = dncMatcher(await loadDnc(ws).catch(() => ({ entries: [] })));
  const rel = (p: string) => p.slice(ws.length + 1);

  const files = ["ase.config.yaml", "dnc.yaml"].map((f) => join(ws, f)).filter(existsSync);
  for (const d of ["accounts", "people", "icps"]) files.push(...walk(join(ws, d)));
  for (const f of files) {
    const errs = validateContent(rel(f), await Bun.file(f).text(), { privacyMode: cfg?.privacy_mode ?? true, dnc, exists: true });
    for (const e of errs) issues.push({ kind: e.includes("do-not-contact") ? "dnc" : "invalid", path: rel(f), detail: e });
  }

  const accountsDir = join(ws, "accounts");
  const names = new Map<string, string>();
  if (existsSync(accountsDir)) {
    for (const domain of readdirSync(accountsDir)) {
      if (domain.startsWith(".") || !statSync(join(accountsDir, domain)).isDirectory()) continue;
      const p = paths.company(ws, domain);
      if (!existsSync(p)) {
        issues.push({ kind: "orphan", path: `accounts/${domain}`, detail: "account folder without company.md" });
        continue;
      }
      let company: Company;
      try {
        company = (await readDoc<Company>(p)).data;
      } catch {
        continue;
      }
      const key = (company.name ?? "").toLowerCase().replace(/\b(inc|ltd|llc|gmbh|bv|nv|sa|ag|plc|srl|bvba)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
      if (key && names.has(key)) issues.push({ kind: "duplicate", path: `accounts/${domain}`, detail: `possibly the same company as accounts/${names.get(key)} (name "${company.name}")` });
      else if (key) names.set(key, domain);
      for (const icp of Object.keys(company.icp_status ?? {})) {
        for (const e of await checkAccount(ws, domain, icp, company)) issues.push({ kind: "contract", path: `accounts/${domain}`, detail: `${icp}: ${e}` });
      }
      const brief = paths.brief(ws, domain);
      if (existsSync(brief)) {
        const { data } = await readDoc<{ open_questions?: number }>(brief);
        if ((data.open_questions ?? 0) > 5) issues.push({ kind: "open_questions", path: rel(brief), detail: `${data.open_questions} open questions` });
      }
    }
  }

  const db = openDb(ws);
  try {
    for (const r of db.query("SELECT path, field, expires_at FROM facts WHERE expires_at < date('now') ORDER BY expires_at").all() as { path: string; field: string; expires_at: string }[]) {
      issues.push({ kind: "stale", path: r.path, detail: `${r.field} expired ${r.expires_at}` });
    }
    for (const r of db.query("SELECT p.path, p.company_domain FROM people p LEFT JOIN accounts a ON a.domain = p.company_domain WHERE p.company_domain IS NOT NULL AND a.domain IS NULL").all() as { path: string; company_domain: string }[]) {
      issues.push({ kind: "orphan", path: r.path, detail: `company ${r.company_domain} has no account file` });
    }
  } finally {
    db.close();
  }
  return issues;
}
