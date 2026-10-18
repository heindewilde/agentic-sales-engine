import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseDoc, readDoc, stringifyDoc } from "./frontmatter.ts";
import { Draft } from "./schemas.ts";
import { relPath, today } from "./workspace.ts";
import { lineDiff } from "./watch.ts";
import { logEvent } from "./outcomes.ts";

/**
 * Outreach drafts live in accounts/<d>/drafts/. When the engine writes a draft it also freezes a copy in
 * drafts/.originals/ — the baseline for learning: once a person edits or sends the draft, the difference
 * between original and final shows what the engine should do differently next time (voice-profile --learn).
 * Nothing here sends anything.
 */

const originalPath = (abs: string) => join(dirname(abs), ".originals", basename(abs));

export function snapshotOriginal(ws: string, rel: string) {
  const abs = join(ws, rel);
  if (!existsSync(abs)) throw new Error(`${rel} not found`);
  const orig = originalPath(abs);
  if (existsSync(orig)) return { original: relPath(ws, orig), created: false };
  mkdirSync(dirname(orig), { recursive: true });
  writeFileSync(orig, readFileSync(abs, "utf8"));
  return { original: relPath(ws, orig), created: true };
}

export interface DraftRow {
  path: string;
  account: string;
  person?: string;
  channel: string;
  step: number;
  status: string;
  created: string;
  learned: boolean;
  has_original: boolean;
}

export async function listDrafts(ws: string, opts: { status?: string; account?: string } = {}): Promise<DraftRow[]> {
  const out: DraftRow[] = [];
  const adir = join(ws, "accounts");
  for (const d of existsSync(adir) ? readdirSync(adir) : []) {
    if (opts.account && d !== opts.account) continue;
    const ddir = join(adir, d, "drafts");
    if (!existsSync(ddir)) continue;
    for (const f of readdirSync(ddir).filter((x) => x.endsWith(".md"))) {
      const abs = join(ddir, f);
      const { data } = await readDoc<Draft>(abs);
      if (opts.status && data.status !== opts.status) continue;
      out.push({
        path: relPath(ws, abs)!, account: d, person: data.person, channel: data.channel, step: data.step ?? 1,
        status: data.status ?? "draft", created: data.created, learned: Boolean(data.learned), has_original: existsSync(originalPath(abs)),
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function markDraft(ws: string, rel: string, status: "draft" | "edited" | "sent" | "discarded", opts: { member?: string; date?: string } = {}) {
  const abs = join(ws, rel);
  const { data, body } = await readDoc<Draft>(abs);
  const wasSent = data.status === "sent";
  data.status = status;
  let event = null;
  if (status === "sent") {
    data.sent_at = opts.date ?? today();
    // The outcome log starts here: a sent draft is the first touch the 21-day silence rule counts from.
    if (!wasSent) {
      event = logEvent(ws, {
        account: data.account, icp: data.icp, type: "sent", person: data.person, member: opts.member,
        channel: data.channel, draft: rel, date: data.sent_at, source: "draft",
      });
    }
  }
  writeFileSync(abs, stringifyDoc(data, body));
  return { path: rel, status, event };
}

/**
 * Save a person's edit of a draft: the engine's original is frozen first (so learning keeps its baseline), the
 * new text is validated like any write, and the draft becomes `edited`.
 */
export async function saveDraft(ws: string, rel: string, body: string) {
  if (!/^accounts\/[^/]+\/drafts\/[^/]+\.md$/.test(rel)) throw new Error(`${rel} is not a draft`);
  const abs = join(ws, rel);
  if (!existsSync(abs)) throw new Error(`${rel} not found`);
  snapshotOriginal(ws, rel);
  const { data } = await readDoc<Draft>(abs);
  if (data.status === "sent") throw new Error(`${rel} was already sent; it can't be edited any more`);
  data.status = "edited";
  const content = stringifyDoc(data, body.endsWith("\n") ? body : `${body}\n`);
  const { validateContent } = await import("./validate.ts");
  const errors = validateContent(rel, content, { privacyMode: true });
  if (errors.length) throw new Error(errors.join("; "));
  writeFileSync(abs, content);
  return { path: rel, status: "edited" as const };
}

/** Pairs of (engine original, human final) for edited/sent drafts not yet learned from. */
export async function pendingEdits(ws: string) {
  const rows = (await listDrafts(ws)).filter((r) => (r.status === "edited" || r.status === "sent") && !r.learned && r.has_original);
  const out: { path: string; channel: string; original: string; final: string; added: string[]; removed: string[]; unchanged: boolean }[] = [];
  for (const r of rows) {
    const abs = join(ws, r.path);
    const original = parseDoc(readFileSync(originalPath(abs), "utf8")).body.trim();
    const final = parseDoc(readFileSync(abs, "utf8")).body.trim();
    const d = lineDiff(original, final);
    out.push({ path: r.path, channel: r.channel, original, final, ...d, unchanged: original === final });
  }
  return out;
}

export async function markLearned(ws: string, rels: string[]) {
  for (const rel of rels) {
    const abs = join(ws, rel);
    const { data, body } = await readDoc<Draft>(abs);
    data.learned = true;
    writeFileSync(abs, stringifyDoc(data, body));
  }
  return { learned: rels.length };
}
