import { persistCandidates } from "./accounts.ts";
import type { CompanyHit } from "./providers/types.ts";

/**
 * After a discover_companies call with an `icp`: save the hits as candidates for that ICP and summarise what was new.
 * Shared by the MCP tool and `ase provider discover_companies`, so discovery persists however it is called.
 */
export async function persistDiscovery(ws: string, args: Record<string, unknown>, res: { provider?: string; cost_usd?: number; budget?: unknown; raw_ref?: string | null; dropped_dnc?: unknown; results: unknown }) {
  const hits = res.results as CompanyHit[];
  const runId = (args.run_id as string | undefined) ?? `${new Date().toISOString().slice(0, 10)}-discover`;
  const saved = await persistCandidates(ws, args.icp as string, runId, `exa: "${String(args.query)}"`, hits.map((h) => ({
    name: h.name, domain: h.domain, url: h.url, description: h.description, employees: h.employees ?? null,
    hq_country: h.hq_country, hq_city: h.hq_city, founded: h.founded ?? null,
    source_url: h.url, confidence: 0.6, method: "exa" as const, raw_ref: h.raw_ref ?? res.raw_ref ?? undefined,
  })));
  return {
    provider: res.provider, cost_usd: res.cost_usd, budget: res.budget, raw_ref: res.raw_ref, dropped_dnc: res.dropped_dnc,
    returned: hits.length, created: saved.created, added_to_icp: saved.added_to_icp, already_known: saved.already_in_icp.length,
    skipped_no_domain: saved.skipped_no_domain.length, run_id: saved.run_id,
    new_share: hits.length ? Math.round((saved.created.length / hits.length) * 100) / 100 : 0,
  };
}
