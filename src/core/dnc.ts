import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseYaml, stringifyYaml } from "./frontmatter.ts";
import { normalizeDomain, normalizeLinkedIn } from "./normalize.ts";
import { DncEntry } from "./schemas.ts";
import { dncMatcher, loadDnc, paths, today } from "./workspace.ts";

/** The do-not-contact list (dnc.yaml): the CLI, the privacy skill and the app all change it through these. */

type Kind = "domain" | "email" | "linkedin";
type Reason = "customer" | "competitor" | "partner" | "opted_out" | "legal" | "other";

function read(ws: string): { entries: unknown[] } {
  const f = paths.dnc(ws);
  const doc = (existsSync(f) ? parseYaml<{ entries?: unknown[] }>(readFileSync(f, "utf8")) : null) ?? { entries: [] };
  doc.entries ??= [];
  return doc as { entries: unknown[] };
}

export function listDnc(ws: string) {
  return read(ws);
}

/** What kind of value this is, from how it looks: a LinkedIn URL, an email address, or a domain. */
export function dncKind(value: string): Kind {
  if (/linkedin\.com\//i.test(value)) return "linkedin";
  if (value.includes("@")) return "email";
  return "domain";
}

export function addDnc(ws: string, value: string, opts: { kind?: Kind; reason?: Reason; note?: string } = {}) {
  const kind = opts.kind ?? dncKind(value);
  const normalized = kind === "domain" ? normalizeDomain(value) : kind === "linkedin" ? normalizeLinkedIn(value) : value.trim().toLowerCase();
  if (!normalized) throw new Error(`cannot normalize ${value}`);
  const doc = read(ws);
  const existing = doc.entries.find((e) => (e as { value: string }).value === normalized);
  if (existing) return { added: null, existing };
  const entry = DncEntry.parse({ kind, value: normalized, reason: opts.reason ?? "other", note: opts.note, added: today() });
  doc.entries.push(entry);
  writeFileSync(paths.dnc(ws), stringifyYaml(doc));
  return { added: entry, existing: null };
}

export function removeDnc(ws: string, value: string) {
  const doc = read(ws);
  const before = doc.entries.length;
  doc.entries = doc.entries.filter((e) => (e as { value: string }).value !== value);
  writeFileSync(paths.dnc(ws), stringifyYaml(doc));
  return { removed: before - doc.entries.length };
}

export async function checkDnc(ws: string, value: string) {
  const m = dncMatcher(await loadDnc(ws));
  return { value, blocked: m.domain(value) || m.email(value) || m.linkedin(value) };
}
