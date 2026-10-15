import { existsSync } from "node:fs";
import { readDoc } from "./frontmatter.ts";
import { STAGES, type Company, type Stage } from "./schemas.ts";
import { paths } from "./workspace.ts";

/**
 * Stage handoff contracts. A stage may only mark an account as having reached `stage` when the
 * artifacts listed here exist — this is what lets the next stage (or a later milestone) pick up
 * the account without re-doing work. Checked by `ase validate --stage <stage> --icp <slug>`.
 */
export interface StageCheck {
  stage: Stage;
  description: string;
  check: (ws: string, domain: string, icp: string, company: Company) => Promise<string[]>;
}

const stageIndex = (s: Stage) => (STAGES as readonly string[]).indexOf(s);

async function briefSectionsUpdated(ws: string, domain: string, sections: string[]): Promise<string[]> {
  const p = paths.brief(ws, domain);
  if (!existsSync(p)) return ["brief.md is missing"];
  const { data } = await readDoc<{ sections_updated?: Record<string, string> }>(p);
  const done = data.sections_updated ?? {};
  return sections.filter((s) => !done[s]).map((s) => `brief section "${s}" has not been written (sections_updated.${s} missing)`);
}

async function scoreFile(ws: string, domain: string, icp: string, mode: "light" | "full"): Promise<string[]> {
  const p = paths.score(ws, domain, icp);
  if (!existsSync(p)) return [`scores/${icp}.md is missing`];
  const { data } = await readDoc<{ mode?: string }>(p);
  if (mode === "full" && data.mode !== "full") return [`scores/${icp}.md is a ${data.mode} score; a full score is required`];
  return [];
}

export const CONTRACTS: StageCheck[] = [
  {
    stage: "discovered",
    description: "company.md with id, name and at least one sourced fact (how we found it)",
    check: async (_ws, _d, _i, c) => (Object.keys(c.facts ?? {}).length || c.sources?.length ? [] : ["company has no sourced facts or sources yet"]),
  },
  {
    stage: "light_scored",
    description: "brief Snapshot written + light score file",
    check: async (ws, d, i) => [...(await briefSectionsUpdated(ws, d, ["Snapshot"])), ...(await scoreFile(ws, d, i, "light"))],
  },
  {
    stage: "shortlisted",
    description: "human approval recorded (approved_by) — GATE 2",
    check: async (_ws, _d, i, c) => (c.icp_status?.[i]?.approved_by ? [] : ["shortlisted without approved_by (GATE 2 must be a human decision)"]),
  },
  {
    stage: "researched",
    description: "brief sections Business & offering, Situation & triggers, People map written; open questions resolved or marked unknown",
    check: async (ws, d) => briefSectionsUpdated(ws, d, ["Business & offering", "Situation & triggers", "People map", "Open questions"]),
  },
  {
    stage: "scored",
    description: "full score file",
    check: async (ws, d, i) => scoreFile(ws, d, i, "full"),
  },
  {
    stage: "outreach_ready",
    description: "brief Ways in written",
    check: async (ws, d) => briefSectionsUpdated(ws, d, ["Ways in"]),
  },
];

/** Check every contract up to and including the account's current stage. */
export async function checkAccount(ws: string, domain: string, icp: string, company: Company): Promise<string[]> {
  const st = company.icp_status?.[icp];
  if (!st || st.stage === "excluded") return [];
  const upTo = stageIndex(st.stage);
  const errors: string[] = [];
  for (const c of CONTRACTS) {
    if (stageIndex(c.stage) > upTo) break;
    for (const e of await c.check(ws, domain, icp, company)) errors.push(`[${c.stage}] ${e}`);
  }
  return errors;
}

/** Stages only move forward (or to `excluded`). */
export function canTransition(from: Stage | undefined, to: Stage): boolean {
  if (to === "excluded" || !from) return true;
  if (from === "excluded") return false;
  return stageIndex(to) >= stageIndex(from);
}
