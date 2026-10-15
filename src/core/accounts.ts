import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readDoc, stringifyDoc } from "./frontmatter.ts";
import { normalizeDomain } from "./normalize.ts";
import { BRIEF_SECTIONS, type Company, type Fact } from "./schemas.ts";
import { validateContent } from "./validate.ts";
import { dncMatcher, loadConfig, loadDnc, paths, today } from "./workspace.ts";

/** A candidate company from discovery or an imported list, before it becomes an account. */
export interface Candidate {
  name: string;
  domain?: string | null;
  url?: string | null;
  description?: string | null;
  employees?: number | string | null;
  hq_country?: string | null;
  hq_city?: string | null;
  industry?: string | null;
  founded?: number | null;
  linkedin_url?: string | null;
  /** where this candidate's data came from: an http(s) URL, or import:<path> */
  source_url: string;
  confidence?: number;
  method?: Fact["method"];
  raw_ref?: string | null;
}

/** Platforms, social networks and aggregators that discovery or imports sometimes return instead of the company itself. */
export const NOT_A_COMPANY = new Set([
  "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "youtube.com", "tiktok.com", "pinterest.com",
  "wikipedia.org", "google.com", "crunchbase.com", "bloomberg.com", "dnb.com", "zoominfo.com", "apollo.io", "glassdoor.com",
  "indeed.com", "kvk.nl", "companyweb.be", "trendstop.be", "medium.com", "substack.com", "shopify.com", "wix.com",
]);

export interface PersistResult {
  run_id: string;
  created: string[];
  added_to_icp: string[];
  already_in_icp: string[];
  skipped_dnc: string[];
  skipped_no_domain: string[];
  skipped_excluded: string[];
}

export function briefSkeleton(domain: string, name: string, changelog: string): string {
  const body = [
    `# ${name} — account brief`,
    "",
    ...BRIEF_SECTIONS.flatMap((s) => [`## ${s}`, s === "Changelog" ? `- ${today()} ${changelog}` : "", ""]),
  ].join("\n");
  return stringifyDoc({ account: domain, sections_updated: {}, open_questions: 0 }, body);
}

function factOf(c: Candidate, value: unknown, ttlDays?: number): Fact {
  return {
    value,
    source_url: c.source_url,
    retrieved_at: today(),
    confidence: c.confidence ?? 0.6,
    ...(ttlDays ? { ttl_days: ttlDays } : {}),
    ...(c.method ? { method: c.method } : {}),
    ...(c.raw_ref ? { raw_ref: c.raw_ref } : {}),
  };
}

/**
 * Turn candidates into workspace accounts for an ICP: dedupe by registrable domain, skip do-not-contact,
 * create company.md + brief.md skeletons for new companies, add the ICP (stage discovered) to existing ones,
 * and log every candidate in lists/<icp>/<run>/candidates.csv. Existing facts are never overwritten.
 */
export async function persistCandidates(ws: string, icp: string, runId: string, source: string, candidates: Candidate[]): Promise<PersistResult> {
  const res: PersistResult = { run_id: runId, created: [], added_to_icp: [], already_in_icp: [], skipped_dnc: [], skipped_no_domain: [], skipped_excluded: [] };
  const cfg = await loadConfig(ws).catch(() => null);
  const dnc = dncMatcher(await loadDnc(ws).catch(() => ({ entries: [] })));
  const ttl = cfg?.ttl_days.firmographics ?? 180;
  const listFile = join(ws, "lists", icp, runId, "candidates.csv");
  mkdirSync(dirname(listFile), { recursive: true });
  if (!existsSync(listFile)) writeFileSync(listFile, "domain,name,status,source\n");
  const seen = new Set<string>();
  const csv = (s: string) => `"${String(s ?? "").replace(/"/g, "'")}"`;

  for (const c of candidates) {
    const domain = normalizeDomain(c.domain ?? c.url ?? "");
    if (!domain || NOT_A_COMPANY.has(domain)) {
      res.skipped_no_domain.push(c.name);
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    if (dnc.domain(domain)) {
      res.skipped_dnc.push(domain);
      appendFileSync(listFile, `${domain},${csv(c.name)},dnc,${csv(source)}\n`);
      continue;
    }
    const cp = paths.company(ws, domain);
    let status: string;
    if (existsSync(cp)) {
      const { data, body } = await readDoc<Company>(cp);
      if (data.dnc) {
        res.skipped_dnc.push(domain);
        status = "dnc";
      } else if (data.icp_status?.[icp]) {
        res.already_in_icp.push(domain);
        status = data.icp_status[icp]!.stage === "excluded" ? "excluded" : "known";
        if (status === "excluded") res.skipped_excluded.push(domain);
      } else {
        data.icp_status = { ...(data.icp_status ?? {}), [icp]: { stage: "discovered", run_id: runId, updated: today() } };
        data.sources = [...new Set([...(data.sources ?? []), c.source_url])];
        writeFileSync(cp, stringifyDoc(data, body));
        res.added_to_icp.push(domain);
        status = "added";
      }
    } else {
      const facts: Record<string, Fact> = {};
      if (c.description) facts.description = factOf(c, String(c.description).slice(0, 600));
      if (c.employees !== null && c.employees !== undefined && c.employees !== "") facts.employees = factOf(c, c.employees, ttl);
      if (c.hq_country) facts.hq_country = factOf(c, c.hq_country);
      if (c.hq_city) facts.hq_city = factOf(c, c.hq_city);
      if (c.industry) facts.industry = factOf(c, c.industry);
      if (c.founded) facts.founded = factOf(c, c.founded);
      if (c.url) facts.website = factOf(c, c.url);
      if (c.linkedin_url) facts.linkedin_company = factOf(c, c.linkedin_url);
      const company: Company = {
        id: domain,
        name: c.name || domain,
        aliases: [],
        dnc: false,
        sources: [c.source_url],
        facts,
        icp_status: { [icp]: { stage: "discovered", run_id: runId, updated: today() } },
      };
      const content = stringifyDoc(company, "");
      const errs = validateContent(`accounts/${domain}/company.md`, content, { privacyMode: true, dnc });
      if (errs.length) throw new Error(`candidate ${domain} would be invalid: ${errs.join("; ")}`);
      mkdirSync(dirname(cp), { recursive: true });
      writeFileSync(cp, content);
      writeFileSync(paths.brief(ws, domain), briefSkeleton(domain, company.name, `discover (${icp}, run ${runId}): found via ${source}.`));
      res.created.push(domain);
      status = "created";
    }
    appendFileSync(listFile, `${domain},${csv(c.name)},${status},${csv(source)}\n`);
  }

  const runMd = join(ws, "lists", icp, runId, "run.md");
  appendFileSync(
    runMd,
    `${existsSync(runMd) ? "" : `# Discovery run ${runId} (${icp})\n\n`}- ${new Date().toISOString()} — ${source}: ${res.created.length} new, ${res.added_to_icp.length} added to ICP, ${res.already_in_icp.length} already known, ${res.skipped_dnc.length} DNC, ${res.skipped_no_domain.length} without domain\n`,
  );
  return res;
}
