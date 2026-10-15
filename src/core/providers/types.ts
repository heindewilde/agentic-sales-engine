/** Provider-neutral operations and result shapes. Adapters (Exa, Firecrawl, replay) map into these. */

export type ProviderName = "exa" | "firecrawl";

export const OPS = ["discover_companies", "find_people", "search_news", "fetch_pages", "extract", "research"] as const;
export type Op = (typeof OPS)[number];

export type ResearchEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpInputs {
  discover_companies: { query: string; num_results?: number; country?: string; exclude_domains?: string[]; with_summary?: boolean };
  find_people: { query: string; num_results?: number };
  search_news: { query: string; since: string; until?: string; num_results?: number; include_domains?: string[] };
  fetch_pages: { urls: string[]; max_chars?: number };
  extract: { urls: string[]; schema: Record<string, unknown>; prompt?: string };
  research: { instructions: string; output_schema?: Record<string, unknown>; effort?: ResearchEffort };
}

export interface CompanyHit {
  name: string;
  domain: string | null;
  url: string;
  description?: string | null;
  employees?: number | null;
  hq_country?: string | null;
  hq_city?: string | null;
  founded?: number | null;
  /** set by the gateway: already an account in this workspace */
  known?: boolean;
}

export interface PersonHit {
  name: string;
  title?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
  location?: string | null;
  source_url: string;
}

export interface NewsHit {
  title: string;
  url: string;
  published?: string | null;
  summary?: string | null;
}

export interface PageHit {
  url: string;
  title?: string | null;
  text: string;
}

export interface ExtractHit {
  url: string;
  data: unknown;
}

export interface ResearchHit {
  text: string | null;
  structured: unknown;
  citations: { url: string; title?: string | null; field?: string | null }[];
}

export interface OpResults {
  discover_companies: CompanyHit[];
  find_people: PersonHit[];
  search_news: NewsHit[];
  fetch_pages: PageHit[];
  extract: ExtractHit[];
  research: ResearchHit;
}

export interface AdapterResult<O extends Op> {
  results: OpResults[O];
  /** USD; `actual` when the provider reported it, `est` when derived from our price table. */
  cost_usd: number;
  cost_kind: "actual" | "est";
  /** URLs that could not be read (fetch_pages / extract), with the reason — never silently dropped */
  failed?: { url: string; reason: string }[];
}

export interface Adapter {
  name: ProviderName;
  supports: readonly Op[];
  run<O extends Op>(op: O, input: OpInputs[O]): Promise<AdapterResult<O>>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "no_provider" | "budget" | "dnc" | "provider_failed" | "replay_miss" | "bad_input",
  ) {
    super(message);
  }
}
