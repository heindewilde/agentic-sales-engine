import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths, today } from "./workspace.ts";

/**
 * Cost ledger: an append-only jsonl file in the workspace (committed, so the team shares spend history).
 * `est` rows are written before a paid call (budget hook / provider estimate), `actual` rows after, when
 * the provider reports real cost. Spend checks take the max of est and actual per call id.
 */
export interface LedgerEntry {
  ts: string;
  run_id: string | null;
  provider: "exa" | "firecrawl" | "anthropic" | "other";
  op: string;
  usd: number;
  kind: "est" | "actual";
  call_id?: string;
  units?: number;
  note?: string;
}

export interface CurrentRun {
  run_id: string;
  stage: string;
  icp?: string;
  budget_usd: number;
  started: string;
  approved_by?: string;
}

export function readLedger(ws: string): LedgerEntry[] {
  const p = paths.ledger(ws);
  if (!existsSync(p)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // tolerate a torn line from a concurrent writer
    }
  }
  return out;
}

export function appendLedger(ws: string, e: Omit<LedgerEntry, "ts"> & { ts?: string }): void {
  const p = paths.ledger(ws);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`);
}

/** Sum spend, counting each call once (actual overrides its estimate when both exist). */
export function sumSpend(entries: LedgerEntry[]): number {
  const byCall = new Map<string, number>();
  let loose = 0;
  for (const e of entries) {
    if (!e.call_id) {
      loose += e.usd;
      continue;
    }
    const prev = byCall.get(e.call_id);
    byCall.set(e.call_id, e.kind === "actual" ? e.usd : Math.max(prev ?? 0, e.usd));
  }
  let total = loose;
  for (const v of byCall.values()) total += v;
  return Math.round(total * 10000) / 10000;
}

export function spentForRun(ws: string, runId: string): number {
  return sumSpend(readLedger(ws).filter((e) => e.run_id === runId));
}

export function spentToday(ws: string): number {
  const d = today();
  return sumSpend(readLedger(ws).filter((e) => e.ts.startsWith(d)));
}

export function currentRun(ws: string): CurrentRun | null {
  const p = paths.currentRun(ws);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CurrentRun;
  } catch {
    return null;
  }
}

export function newRunId(stage: string): string {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${t}-${stage}`;
}
