import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDoc, stringifyDoc } from "./frontmatter.ts";
import type { Company } from "./schemas.ts";
import { validateContent } from "./validate.ts";
import { loadConfig, paths, today } from "./workspace.ts";

/**
 * The human gates as engine functions, so the CLI, the skills and the app record them the same way:
 * GATE 1 approves an ICP, GATE 3 records which full scores a person reviewed (GATE 2 is approveShortlist).
 */

/** Approvals must name a team member from ase.config.yaml (when members are configured). */
export async function requireMember(ws: string, by: string) {
  if (!by?.trim()) throw new Error("an approval needs a name: --approved-by <member>");
  const cfg = await loadConfig(ws).catch(() => null);
  if (cfg && cfg.members.length && !cfg.members.some((m) => m.id === by)) {
    throw new Error(`"${by}" is not a member in ase.config.yaml — approvals must name a team member`);
  }
}

/** GATE 1: mark an ICP approved, validated the same way the write hook validates a hand edit. */
export async function approveIcp(ws: string, slug: string, by: string) {
  await requireMember(ws, by);
  const p = paths.icp(ws, slug);
  if (!existsSync(p)) throw new Error(`icps/${slug}/icp.md not found`);
  const { data, body } = await readDoc<Record<string, unknown>>(p);
  if (data.status === "approved") return { icp: slug, status: "approved", approved_by: data.approved_by, already: true };
  const next = { ...data, status: "approved", approved_by: by, approved_at: today() };
  const content = stringifyDoc(next, body);
  const errors = validateContent(`icps/${slug}/icp.md`, content, { privacyMode: true });
  if (errors.length) throw new Error(`ICP ${slug} can't be approved yet: ${errors.join("; ")}`);
  writeFileSync(p, content);
  return { icp: slug, status: "approved", approved_by: by, approved_at: next.approved_at, already: false };
}

/** GATE 3: record that a person reviewed these accounts' full scores, which clears them for ways in. */
export async function reviewScores(ws: string, icp: string, domains: string[], by: string) {
  await requireMember(ws, by);
  const reviewed: string[] = [];
  const skipped: { domain: string; reason: string }[] = [];
  for (const d of domains) {
    const p = paths.company(ws, d);
    if (!existsSync(p)) { skipped.push({ domain: d, reason: "no account file" }); continue; }
    const { data, body } = await readDoc<Company>(p);
    const st = data.icp_status?.[icp];
    if (!st) { skipped.push({ domain: d, reason: `not in ICP ${icp}` }); continue; }
    if (st.stage !== "scored" && st.stage !== "outreach_ready") { skipped.push({ domain: d, reason: `stage ${st.stage} has no full score yet` }); continue; }
    st.reviewed_by = by;
    st.reviewed_at = today();
    writeFileSync(p, stringifyDoc(data, body));
    reviewed.push(d);
  }
  return { icp, reviewed, skipped, by };
}

/** Scored tier A/B accounts nobody has reviewed yet: what GATE 3 is waiting on. */
export async function awaitingReview(ws: string, icp: string): Promise<string[]> {
  const dir = join(ws, "accounts");
  const out: string[] = [];
  for (const d of existsSync(dir) ? readdirSync(dir) : []) {
    const p = paths.company(ws, d);
    if (!existsSync(p)) continue;
    const st = (await readDoc<Company>(p)).data.icp_status?.[icp];
    if (st?.stage === "scored" && (st.tier === "A" || st.tier === "B") && !st.reviewed_by) out.push(d);
  }
  return out.sort();
}
