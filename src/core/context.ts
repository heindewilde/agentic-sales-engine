import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDoc, readDoc } from "./frontmatter.ts";
import { readWarmMatches } from "./importers.ts";
import type { Company, Icp, Signal } from "./schemas.ts";
import { factorsFor } from "./score.ts";
import { loadScoring } from "./scorefile.ts";
import { paths } from "./workspace.ts";

/**
 * One compact JSON with everything a stage session needs for a set of accounts — instead of the session reading
 * ICP, rubric, rules, learnings and every account file one by one (each read is a turn that re-sends the context).
 */

/**
 * The binding short rules every stage session gets: the `## Digest` sections of references/rules.md and
 * references/judging.md. The rules are written once, in those files, and never copied into code.
 */
export const RULES_DIGEST = [digestOf("rules.md"), digestOf("judging.md")].join("\n");

function digestOf(file: string): string {
  const text = readFileSync(join(import.meta.dir, "../../references", file), "utf8");
  const m = /^## Digest[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  if (!m) throw new Error(`references/${file} has no "## Digest" section`);
  return m[1]!.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).join("\n");
}

function compactFacts(c: Company): Record<string, [unknown, number, string]> {
  const out: Record<string, [unknown, number, string]> = {};
  for (const [k, f] of Object.entries(c.facts ?? {})) out[k] = [f.value, f.confidence, f.source_url];
  return out;
}

function sectionText(body: string, name: string): string | null {
  const m = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m").exec(body);
  const t = m?.[1]?.trim();
  return t && !/^_.*_$/.test(t) ? t : null;
}

function learningLines(ws: string): string[] {
  const out: string[] = [];
  for (const f of ["learnings/preferences.md", "learnings/corrections.md"]) {
    const p = join(ws, f);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split("\n")) if (/^\s*-\s+\S/.test(l)) out.push(l.trim().slice(0, 300));
  }
  return out.slice(-30);
}

export async function buildContext(ws: string, icpSlug: string, domains: string[], mode: "light" | "full") {
  const icp = (await readDoc<Icp>(paths.icp(ws, icpSlug))).data;
  const scoring = await loadScoring(ws, icpSlug);
  const inScope = factorsFor(scoring, mode) as (ReturnType<typeof factorsFor>[number] & { auto?: unknown })[];
  const warm = readWarmMatches(ws);
  const accounts = [];
  for (const d of domains) {
    const cp = paths.company(ws, d);
    if (!existsSync(cp)) {
      accounts.push({ domain: d, error: "no account file" });
      continue;
    }
    const c = (await readDoc<Company>(cp)).data;
    const briefBody = existsSync(paths.brief(ws, d)) ? parseDoc(readFileSync(paths.brief(ws, d), "utf8")).body : "";
    const sdir = join(ws, "accounts", d, "signals");
    const signals = existsSync(sdir)
      ? await Promise.all(readdirSync(sdir).filter((f) => f.endsWith(".md")).map(async (f) => {
          const s = (await readDoc<Signal>(join(sdir, f))).data;
          return { type: s.type, date: s.date, title: s.title, source_url: s.source_url };
        }))
      : [];
    accounts.push({
      domain: d,
      name: c.name,
      stage: c.icp_status?.[icpSlug]?.stage ?? null,
      website: (c.facts?.website?.value as string | undefined) ?? `https://${d}`,
      facts: compactFacts(c),
      snapshot: sectionText(briefBody, "Snapshot"),
      ...(mode === "full"
        ? {
            open_questions: sectionText(briefBody, "Open questions"),
            signals,
            warm_matches: warm.filter((w) => w.account === d).map((w) => ({ member: w.member, name: w.name, position: w.position, connected_on: w.connected_on })),
          }
        : {}),
    });
  }
  return {
    icp: {
      slug: icp.slug, name: icp.name, offering: icp.offering, geographies: icp.geographies, firmographics: icp.firmographics,
      technographics: icp.technographics, triggers: icp.triggers, exclusions: icp.exclusions,
      personas: (icp.personas ?? []).map((p) => ({ name: p.name, titles: p.titles, role_in_deal: p.role_in_deal })),
    },
    mode,
    factors: inScope.filter((f) => !f.auto).map((f) => ({ id: f.id, group: f.group, q: f.question, levels: f.levels, ...(f.examples ? { examples: f.examples } : {}), hint: f.evidence_hint, knockout: f.knockout?.level_lte })),
    auto_factors: inScope.filter((f) => f.auto).map((f) => {
      const a = f.auto as { fact?: string; signals?: { types: string[]; within_days: number } };
      return a.signals
        ? { id: f.id, computed_from_signals: a.signals, note: "scored by the engine by counting dated signals of these types in this window — record every such event as a signal (type, date, source), don't judge the factor" }
        : { id: f.id, computed_from_fact: a.fact, note: "scored by the engine from this fact — provide the fact, don't judge the factor" };
    }),
    rules: RULES_DIGEST,
    learnings: learningLines(ws),
    accounts,
  };
}
