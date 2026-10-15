import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../core/context.ts";
import { parseDoc } from "../core/frontmatter.ts";
import type { Company, ScoreFile } from "../core/schemas.ts";
import { paths } from "../core/workspace.ts";
import type { DatasetItem } from "./backends.ts";

/**
 * A dataset item per account: the input a stage session gets (`ase context`) and the expected output — the
 * account's current score (factor levels) and brief snapshot. Run it on a reviewed workspace (e.g. the golden
 * fixture or a benchmark you've checked) so "expected" means "what good looks like".
 */
export async function buildDataset(ws: string, icp: string, mode: "light" | "full", domains?: string[]): Promise<DatasetItem[]> {
  const dir = join(ws, "accounts");
  const all = domains ?? (existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(paths.score(ws, d, icp))) : []);
  const items: DatasetItem[] = [];
  for (const d of all) {
    const scorePath = paths.score(ws, d, icp);
    if (!existsSync(scorePath)) continue;
    const s = parseDoc<ScoreFile>(readFileSync(scorePath, "utf8")).data;
    if (s.mode !== mode && mode === "full") continue;
    const ctx = await buildContext(ws, icp, [d], mode);
    const company = parseDoc<Company>(readFileSync(paths.company(ws, d), "utf8")).data;
    const brief = existsSync(paths.brief(ws, d)) ? parseDoc(readFileSync(paths.brief(ws, d), "utf8")).body : "";
    const snapshot = /^##\s+Snapshot\s*$([\s\S]*?)(?=^##\s)/m.exec(brief)?.[1]?.trim() ?? null;
    items.push({
      id: `${icp}/${mode}/${d}`,
      input: { account: ctx.accounts[0], factors: ctx.factors, auto_factors: ctx.auto_factors, icp: ctx.icp.slug },
      expected: { total: s.total, tier: s.tier, levels: Object.fromEntries(s.factors.map((f) => [f.id, f.level])), snapshot },
      metadata: { icp, mode, account: d, name: company.name, scoring_version: s.scoring_version },
    });
  }
  return items;
}
