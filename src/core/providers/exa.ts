import Exa from "exa-js";
import { normalizeDomain, normalizeLinkedIn } from "../normalize.ts";
import { estimate } from "./pricing.ts";
import type { Adapter, AdapterResult, CompanyHit, ExtractHit, Op, OpInputs, PageHit, PersonHit } from "./types.ts";

type AnyResult = {
  title?: string | null;
  url: string;
  publishedDate?: string;
  summary?: string;
  text?: string;
  highlights?: string[];
  entities?: { type: string; properties: Record<string, any> }[];
};

const cost = (r: { costDollars?: { total?: number } }, fallback: number) =>
  typeof r.costDollars?.total === "number" ? { cost_usd: r.costDollars.total, cost_kind: "actual" as const } : { cost_usd: fallback, cost_kind: "est" as const };

function currentJob(history: any[] | undefined): any | undefined {
  if (!history?.length) return undefined;
  return history.find((h) => !h?.dates?.to) ?? history[0];
}

export function mapCompany(r: AnyResult): CompanyHit {
  const p = r.entities?.find((e) => e.type === "company")?.properties ?? {};
  return {
    name: p.name ?? r.title ?? normalizeDomain(r.url) ?? r.url,
    domain: normalizeDomain(r.url),
    url: r.url,
    description: p.description ?? r.summary ?? null,
    employees: p.workforce?.total ?? null,
    hq_country: p.headquarters?.country ?? null,
    hq_city: p.headquarters?.city ?? null,
    founded: p.foundedYear ?? null,
  };
}

export function mapPerson(r: AnyResult): PersonHit {
  const p = r.entities?.find((e) => e.type === "person")?.properties ?? {};
  const job = currentJob(p.workHistory);
  return {
    name: p.name ?? (r.title ?? "").split(/\s[-|–]\s/)[0] ?? "",
    title: job?.title ?? null,
    company: job?.company?.name ?? null,
    linkedin_url: normalizeLinkedIn(r.url),
    location: p.location ?? job?.location ?? null,
    source_url: r.url,
  };
}

export function exaAdapter(apiKey: string): Adapter {
  const exa = new Exa(apiKey);
  return {
    name: "exa",
    supports: ["discover_companies", "find_people", "search_news", "fetch_pages", "extract", "research"],
    async run<O extends Op>(op: O, input: OpInputs[O]): Promise<AdapterResult<O>> {
      const est = estimate("exa", op, input);
      switch (op) {
        case "discover_companies": {
          const i = input as OpInputs["discover_companies"];
          const r = await exa.search(i.query, {
            category: "company",
            numResults: i.num_results ?? 25,
            excludeDomains: i.exclude_domains,
            userLocation: i.country,
            contents: i.with_summary === false ? false : { summary: { query: "What does this company do, for whom, where is it headquartered and roughly how many employees?" } },
          } as any);
          return { results: (r.results as AnyResult[]).map(mapCompany), ...cost(r, est) } as AdapterResult<O>;
        }
        case "find_people": {
          const i = input as OpInputs["find_people"];
          const r = await exa.search(i.query, { category: "people", numResults: i.num_results ?? 10, contents: false } as any);
          return { results: (r.results as AnyResult[]).map(mapPerson).filter((p) => p.name), ...cost(r, est) } as AdapterResult<O>;
        }
        case "search_news": {
          const i = input as OpInputs["search_news"];
          const r = await exa.search(i.query, {
            category: "news",
            numResults: i.num_results ?? 10,
            startPublishedDate: i.since,
            endPublishedDate: i.until,
            includeDomains: i.include_domains,
            contents: { summary: { query: "What happened, to which company, and when?" } },
          } as any);
          const results = (r.results as AnyResult[]).map((x) => ({ title: x.title ?? x.url, url: x.url, published: x.publishedDate ?? null, summary: x.summary ?? null }));
          return { results, ...cost(r, est) } as AdapterResult<O>;
        }
        case "fetch_pages": {
          const i = input as OpInputs["fetch_pages"];
          const r = await exa.getContents(i.urls, { text: { maxCharacters: i.max_chars ?? 8000 } } as any);
          const got = (r.results as AnyResult[]).filter((x) => (x.text ?? "").trim());
          const results: PageHit[] = got.map((x) => ({ url: x.url, title: x.title ?? null, text: x.text ?? "" }));
          // Exa omits pages it can't read; name them (with its status reason when given) instead of dropping them silently.
          const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
          const have = new Set(got.map((x) => norm(x.url)));
          const statuses = ((r as unknown as { statuses?: { id: string; status: string; error?: { tag?: string; httpStatusCode?: number } }[] }).statuses ?? []);
          const failed = i.urls.filter((u) => !have.has(norm(u))).map((u) => {
            const st = statuses.find((x) => norm(x.id) === norm(u));
            return { url: u, reason: st?.error ? `${st.error.tag ?? "error"}${st.error.httpStatusCode ? ` (HTTP ${st.error.httpStatusCode})` : ""}` : "not returned (unreachable or empty)" };
          });
          return { results, failed, ...cost(r, est) } as AdapterResult<O>;
        }
        case "extract": {
          const i = input as OpInputs["extract"];
          const r = await exa.getContents(i.urls, { summary: { query: i.prompt ?? "Extract the requested fields.", schema: i.schema } } as any);
          const results: ExtractHit[] = (r.results as AnyResult[]).map((x) => {
            let data: unknown = x.summary ?? null;
            try {
              data = typeof x.summary === "string" ? JSON.parse(x.summary) : x.summary;
            } catch {}
            return { url: x.url, data };
          });
          return { results, ...cost(r, est) } as AdapterResult<O>;
        }
        case "research": {
          const i = input as OpInputs["research"];
          const run: any = await exa.agent.runs.createAndWait(
            { query: i.instructions, outputSchema: i.output_schema, effort: i.effort ?? "medium" } as any,
            { timeoutMs: 20 * 60_000, pollInterval: 3000 },
          );
          const citations = (run.output?.grounding ?? []).flatMap((g: any) =>
            (g.citations ?? []).map((c: any) => ({ url: c.url, title: c.title ?? null, field: g.field ?? null })),
          );
          return {
            results: { text: run.output?.text ?? null, structured: run.output?.structured ?? null, citations },
            ...cost(run, est),
          } as AdapterResult<O>;
        }
      }
      throw new Error(`exa adapter does not support ${op}`);
    },
  };
}
