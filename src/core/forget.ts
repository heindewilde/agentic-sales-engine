import { existsSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDoc, parseYaml, stringifyYaml } from "./frontmatter.ts";
import { normalizeLinkedIn } from "./normalize.ts";
import type { Person } from "./schemas.ts";
import { paths, today } from "./workspace.ts";

export interface ForgetResult {
  deleted: string[];
  redactedRaw: string[];
  warmMatchFilesUpdated: string[];
  remainingMentions: { path: string; line: number; text: string }[];
  dncAdded: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === ".git" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(md|ya?ml|csv|jsonl)$/.test(name)) out.push(p);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * GDPR erasure. Deletes the person file, removes them from warm-match files, redacts raw snapshots
 * (the one sanctioned mutation of raw/), optionally adds a do-not-contact entry, and returns any
 * remaining mentions in agent-written prose so the forget-person skill can redact those by hand.
 * The person's own team connection exports (team/<m>/connections.csv) are the member's data and stay untouched.
 */
export async function forgetPerson(ws: string, personId: string, opts: { addDnc: boolean }): Promise<ForgetResult> {
  const res: ForgetResult = { deleted: [], redactedRaw: [], warmMatchFilesUpdated: [], remainingMentions: [], dncAdded: false };
  const pFile = paths.person(ws, personId);
  let person: Partial<Person> = { id: personId };
  if (existsSync(pFile)) {
    person = (await readDoc<Person>(pFile)).data;
    rmSync(pFile);
    res.deleted.push(`people/${personId}.md`);
  }
  const li = normalizeLinkedIn(person.linkedin_url);
  const needles = [person.name, person.linkedin_url, li].filter((s): s is string => Boolean(s && s.length > 3));
  const pattern = needles.length ? new RegExp(needles.map(escape).join("|"), "gi") : null;

  const teamDir = join(ws, "team");
  if (existsSync(teamDir)) {
    for (const m of readdirSync(teamDir)) {
      const f = join(teamDir, m, "warm-matches.yaml");
      if (!existsSync(f)) continue;
      const doc = (parseYaml<{ matches?: { person_id?: string; linkedin_url?: string }[] }>(readFileSync(f, "utf8")) ?? {}) as { matches?: { person_id?: string; linkedin_url?: string }[] };
      const before = doc.matches?.length ?? 0;
      doc.matches = (doc.matches ?? []).filter((x) => x.person_id !== personId && (!li || normalizeLinkedIn(x.linkedin_url) !== li));
      if (doc.matches.length !== before) {
        writeFileSync(f, stringifyYaml(doc));
        res.warmMatchFilesUpdated.push(`team/${m}/warm-matches.yaml`);
      }
    }
  }

  if (pattern) {
    for (const f of walk(paths.raw(ws))) {
      const text = readFileSync(f, "utf8");
      const red = text.replace(pattern, "[redacted]");
      if (red !== text) {
        writeFileSync(f, red);
        res.redactedRaw.push(f.slice(ws.length + 1));
      }
    }
    for (const f of [...walk(join(ws, "accounts")), ...walk(join(ws, "lists")), ...walk(join(ws, "outcomes")), ...walk(join(ws, "learnings"))]) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        pattern.lastIndex = 0;
        if (pattern.test(line)) res.remainingMentions.push({ path: f.slice(ws.length + 1), line: i + 1, text: line.slice(0, 200) });
      });
    }
  }

  if (opts.addDnc && li) {
    const f = paths.dnc(ws);
    const doc = (existsSync(f) ? parseYaml<{ entries?: unknown[] }>(readFileSync(f, "utf8")) : null) ?? { entries: [] };
    doc.entries = [...(doc.entries ?? []), { kind: "linkedin", value: li, reason: "opted_out", note: "erasure request", added: today() }];
    writeFileSync(f, stringifyYaml(doc));
    res.dncAdded = true;
  }
  return res;
}
