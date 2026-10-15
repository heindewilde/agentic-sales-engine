import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseYaml } from "./frontmatter.ts";
import { Config, Dnc, type Config as ConfigT, type Dnc as DncT } from "./schemas.ts";
import { normalizeDomain, normalizeLinkedIn } from "./normalize.ts";

export const CONFIG_FILE = "ase.config.yaml";

/** Find the workspace root: $ASE_WORKSPACE, $CLAUDE_PROJECT_DIR, or the nearest ancestor holding ase.config.yaml. */
export function findWorkspace(start?: string): string | null {
  const candidates = [process.env.ASE_WORKSPACE, start, process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(
    (c): c is string => Boolean(c),
  );
  for (const c of candidates) {
    let dir = resolve(c);
    for (;;) {
      if (existsSync(join(dir, CONFIG_FILE))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function requireWorkspace(start?: string): string {
  const ws = findWorkspace(start);
  if (!ws) {
    throw new Error(`No workspace found (no ${CONFIG_FILE} in this directory or its parents). Run /agentic-sales-engine:setup first.`);
  }
  return ws;
}

/** Workspace-relative POSIX path, or null when the path lies outside the workspace. */
export function relPath(ws: string, path: string): string | null {
  const rel = relative(ws, resolve(ws, path));
  if (rel.startsWith("..") || rel === "") return null;
  return rel.split(sep).join("/");
}

export const paths = {
  config: (ws: string) => join(ws, CONFIG_FILE),
  dnc: (ws: string) => join(ws, "dnc.yaml"),
  db: (ws: string) => join(ws, ".ase", "ase.db"),
  ledger: (ws: string) => join(ws, "ledger", "costs.jsonl"),
  currentRun: (ws: string) => join(ws, ".ase", "current-run.json"),
  account: (ws: string, domain: string) => join(ws, "accounts", domain),
  company: (ws: string, domain: string) => join(ws, "accounts", domain, "company.md"),
  brief: (ws: string, domain: string) => join(ws, "accounts", domain, "brief.md"),
  score: (ws: string, domain: string, icp: string) => join(ws, "accounts", domain, "scores", `${icp}.md`),
  person: (ws: string, id: string) => join(ws, "people", `${id}.md`),
  icp: (ws: string, slug: string) => join(ws, "icps", slug, "icp.md"),
  scoring: (ws: string, slug: string) => join(ws, "icps", slug, "scoring.yaml"),
  raw: (ws: string) => join(ws, "raw"),
};

export async function loadConfig(ws: string): Promise<ConfigT> {
  const text = await Bun.file(paths.config(ws)).text();
  return Config.parse(parseYaml(text) ?? {});
}

export async function loadDnc(ws: string): Promise<DncT> {
  const f = Bun.file(paths.dnc(ws));
  if (!(await f.exists())) return { entries: [] };
  return Dnc.parse(parseYaml(await f.text()) ?? {});
}

export interface DncMatcher {
  domain(d: string | null | undefined): boolean;
  email(e: string | null | undefined): boolean;
  linkedin(u: string | null | undefined): boolean;
  reason(kind: "domain" | "email" | "linkedin", value: string): string | undefined;
}

export function dncMatcher(dnc: DncT): DncMatcher {
  const domains = new Map<string, string>();
  const emails = new Map<string, string>();
  const lis = new Map<string, string>();
  for (const e of dnc.entries) {
    if (e.kind === "domain") {
      const d = normalizeDomain(e.value);
      if (d) domains.set(d, e.reason);
    } else if (e.kind === "email") emails.set(e.value.trim().toLowerCase(), e.reason);
    else {
      const l = normalizeLinkedIn(e.value);
      if (l) lis.set(l, e.reason);
    }
  }
  const m: DncMatcher = {
    domain: (d) => {
      const n = normalizeDomain(d);
      return n ? domains.has(n) : false;
    },
    email: (e) => {
      if (!e) return false;
      const k = e.trim().toLowerCase();
      return emails.has(k) || m.domain(k);
    },
    linkedin: (u) => {
      const n = normalizeLinkedIn(u);
      return n ? lis.has(n) : false;
    },
    reason: (kind, value) => {
      if (kind === "domain") return domains.get(normalizeDomain(value) ?? "");
      if (kind === "email") return emails.get(value.trim().toLowerCase()) ?? domains.get(normalizeDomain(value) ?? "");
      return lis.get(normalizeLinkedIn(value) ?? "");
    },
  };
  return m;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
