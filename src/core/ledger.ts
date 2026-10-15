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

/**
 * Rough per-call USD estimates for MCP tools, used by the budget hook when the agent calls providers
 * interactively. Scripts record actual costs where the provider returns them. Prices as of Oct 2026:
 * Exa search ~$5-7/1k, agent effort tiers $0.012-$1; Firecrawl ~ $0.004/credit (Hobby), JSON +4 credits.
 * Deliberately pessimistic: overestimating stops runs early; underestimating overspends.
 */
export function estimateMcpCall(toolName: string, input: Record<string, unknown>): { provider: LedgerEntry["provider"]; op: string; usd: number } {
  const t = toolName.toLowerCase();
  const op = t.split("__").pop() ?? t;
  if (t.includes("exa")) {
    if (op.includes("agent")) {
      const effort = String(input.effort ?? input.reasoning_effort ?? "medium").toLowerCase();
      const table: Record<string, number> = { minimal: 0.012, low: 0.025, medium: 0.1, high: 0.5, xhigh: 1, auto: 1, ultra: 5 };
      return { provider: "exa", op, usd: table[effort] ?? 0.5 };
    }
    if (op.includes("fetch") || op.includes("contents") || op.includes("crawl")) {
      const n = Array.isArray(input.urls) ? input.urls.length : 1;
      return { provider: "exa", op, usd: 0.003 * Math.max(1, n) };
    }
    const n = Number(input.numResults ?? input.num_results ?? 10);
    return { provider: "exa", op, usd: 0.007 + Math.max(0, n - 10) * 0.001 };
  }
  if (t.includes("firecrawl")) {
    const credit = 0.004;
    const json = JSON.stringify(input).includes("json") ? 4 : 0;
    if (op.includes("agent")) return { provider: "firecrawl", op, usd: 300 * credit };
    if (op.includes("crawl") && !op.includes("status")) {
      const limit = Number(input.limit ?? 20);
      return { provider: "firecrawl", op, usd: limit * (1 + json) * credit };
    }
    if (op.includes("search")) {
      const n = Number(input.limit ?? 10);
      return { provider: "firecrawl", op, usd: Math.ceil(n / 10) * 2 * credit };
    }
    if (op.includes("status") || op.includes("map")) return { provider: "firecrawl", op, usd: credit };
    return { provider: "firecrawl", op, usd: (1 + json) * credit };
  }
  return { provider: "other", op, usd: 0 };
}
