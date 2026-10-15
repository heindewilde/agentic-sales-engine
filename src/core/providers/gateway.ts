import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { stringifyDoc } from "../frontmatter.ts";
import { appendLedger, currentRun, spentForRun, spentToday } from "../ledger.ts";
import { normalizeDomain } from "../normalize.ts";
import type { Config } from "../schemas.ts";
import { dncMatcher, loadConfig, loadDnc, paths } from "../workspace.ts";
import { cassetteDir, providerMode, withCassettes, type Mode } from "./cassette.ts";
import { exaAdapter } from "./exa.ts";
import { firecrawlAdapter } from "./firecrawl.ts";
import { estimate } from "./pricing.ts";
import { focusText } from "../focus.ts";
import { setAttrs, withSpan } from "../tracing.ts";
import { ProviderError, type Adapter, type Op, type OpInputs, type OpResults, type ProviderName } from "./types.ts";

/** Without an active run, a single call may not cost more than this (deep work must be a budgeted run). */
export const UNBUDGETED_CALL_CAP_USD = 0.5;

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date");
const urls = z.array(z.string().url()).min(1).max(25);

export const INPUT_SCHEMAS = {
  discover_companies: z.object({
    query: z.string().min(3),
    icp: z.string().regex(/^[a-z0-9-]+$/).optional().describe("save new candidates as accounts for this ICP (stage discovered) and return a compact summary"),
    run_id: z.string().optional().describe("discovery run id to group candidates (lists/<icp>/<run_id>/); defaults to today's discover run"),
    num_results: z.number().int().min(1).max(100).optional(),
    country: z.string().length(2).optional(),
    exclude_domains: z.array(z.string()).optional(),
    with_summary: z.boolean().optional(),
  }),
  find_people: z.object({ query: z.string().min(3), num_results: z.number().int().min(1).max(50).optional() }),
  search_news: z.object({
    query: z.string().min(3),
    since: isoDate,
    until: isoDate.optional(),
    num_results: z.number().int().min(1).max(50).optional(),
    include_domains: z.array(z.string()).optional(),
  }),
  fetch_pages: z.object({
    urls,
    max_chars: z.number().int().min(500).max(50_000).optional(),
    focus: z.string().max(300).optional().describe("what you need from these pages; returns only the relevant paragraphs (full page saved as raw_ref)"),
  }),
  extract: z.object({ urls, schema: z.record(z.string(), z.unknown()), prompt: z.string().optional() }),
  research: z.object({
    instructions: z.string().min(10),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  }),
} satisfies Record<Op, z.ZodType>;

/** Which config.providers preference applies to each op. */
const PREF_KEY: Record<Op, keyof Config["providers"]> = {
  discover_companies: "discover",
  find_people: "discover",
  search_news: "news",
  fetch_pages: "extract",
  extract: "extract",
  research: "research",
};

const SUPPORTS: Record<ProviderName, readonly Op[]> = {
  exa: ["discover_companies", "find_people", "search_news", "fetch_pages", "extract", "research"],
  firecrawl: ["fetch_pages", "extract", "search_news"],
};

export interface GatewayOptions {
  ws: string;
  /** Inject adapters (tests). `null` = explicitly unavailable. Omitted = built from env keys. */
  adapters?: Partial<Record<ProviderName, Adapter | null>>;
  mode?: Mode;
  cassettes?: string;
  /** Force a provider instead of the configured preference. */
  provider?: ProviderName;
}

export interface GatewayResult<O extends Op> {
  provider: ProviderName;
  op: O;
  results: OpResults[O];
  cost_usd: number;
  cost_kind: "actual" | "est";
  raw_ref: string | null;
  dropped_dnc: number;
  budget: { day_spent_usd: number; day_cap_usd: number; run_id: string | null; run_spent_usd: number | null; run_budget_usd: number | null };
}

/**
 * Provider keys: EXA_API_KEY etc. (set from plugin userConfig in .mcp.json, or from a .env for CLI runs),
 * falling back to ASE_EXA_API_KEY etc. — batch runs pass those, because .mcp.json's env block overrides
 * the inherited EXA_API_KEY with the (possibly empty) userConfig value.
 */
function envKey(name: string): string | undefined {
  for (const n of [name, `ASE_${name}`]) {
    const v = process.env[n];
    // Unset plugin userConfig values may arrive as empty strings or unexpanded placeholders.
    if (v && !v.startsWith("${")) return v;
  }
  return undefined;
}

export function availableAdapters(opts: Pick<GatewayOptions, "adapters" | "mode" | "cassettes">): Partial<Record<ProviderName, Adapter>> {
  const mode = opts.mode ?? providerMode();
  const dir = opts.cassettes ?? cassetteDir();
  const out: Partial<Record<ProviderName, Adapter>> = {};
  for (const name of ["exa", "firecrawl"] as const) {
    let inner: Adapter | null | undefined = opts.adapters?.[name];
    if (inner === undefined) {
      if (name === "exa") inner = envKey("EXA_API_KEY") ? exaAdapter(envKey("EXA_API_KEY")!) : null;
      else {
        const key = envKey("FIRECRAWL_API_KEY");
        const url = envKey("FIRECRAWL_BASE_URL");
        inner = key || url ? firecrawlAdapter(key, url) : null;
      }
    }
    if (mode === "replay") out[name] = withCassettes(name, SUPPORTS[name], inner, "replay", dir);
    else if (inner) out[name] = mode === "record" ? withCassettes(name, SUPPORTS[name], inner, "record", dir) : inner;
  }
  return out;
}

export function chooseProvider(op: Op, cfg: Config | null, avail: Partial<Record<ProviderName, Adapter>>, forced?: ProviderName): Adapter {
  if (forced) {
    const a = avail[forced];
    if (!a || !a.supports.includes(op)) throw new ProviderError(`${forced} is not configured or does not support ${op}`, "no_provider");
    return a;
  }
  const pref = cfg?.providers[PREF_KEY[op]];
  const order = [pref, "exa", "firecrawl"].filter((p, i, arr): p is ProviderName => (p === "exa" || p === "firecrawl") && arr.indexOf(p) === i);
  for (const p of order) {
    const a = avail[p];
    if (a && a.supports.includes(op)) return a;
  }
  throw new ProviderError(
    `No configured provider can ${op.replace("_", " ")}. Configure an Exa key (or Firecrawl for page fetch/extract) via /plugin → agentic-sales-engine, ` +
      "or fall back to the built-in WebSearch/WebFetch tools (tier T0).",
    "no_provider",
  );
}

/** Write an immutable raw snapshot and return its workspace-relative path. */
export function writeRaw(ws: string, meta: Record<string, unknown>, content: string): string {
  const body = content.length > 20_000 ? `${content.slice(0, 20_000)}\n\n[truncated]` : content;
  const hash = createHash("sha256").update(`${String(meta.url ?? meta.query ?? "")}\n${body}`).digest("hex").slice(0, 12);
  const rel = `raw/${new Date().toISOString().slice(0, 7)}/${hash}.md`;
  const abs = join(ws, rel);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, stringifyDoc({ ...meta, fetched_at: new Date().toISOString(), sha: hash }, `${body}\n`));
  }
  return rel;
}

/**
 * The single entry point for paid provider calls: validate → pick provider → budget gate → call →
 * ledger → raw snapshots → DNC filtering. Throws ProviderError with an actionable message.
 */
export async function callProvider<O extends Op>(op: O, rawInput: unknown, opts: GatewayOptions): Promise<GatewayResult<O>> {
  return withSpan(`provider.${op}`, { "ase.op": op }, async (span) => {
    try {
      const r = await callProviderInner(op, rawInput, opts);
      setAttrs(span, {
        "ase.provider": r.provider, "ase.cost_usd": r.cost_usd, "ase.cost_kind": r.cost_kind, "ase.run_id": r.budget.run_id,
        "ase.results": Array.isArray(r.results) ? r.results.length : 1, "ase.dropped_dnc": r.dropped_dnc, "ase.raw_ref": r.raw_ref,
      });
      return r;
    } catch (e) {
      if (e instanceof ProviderError) setAttrs(span, { "ase.error_code": e.code });
      throw e;
    }
  });
}

async function callProviderInner<O extends Op>(op: O, rawInput: unknown, opts: GatewayOptions): Promise<GatewayResult<O>> {
  const parsed = INPUT_SCHEMAS[op].safeParse(rawInput);
  if (!parsed.success) throw new ProviderError(`invalid input for ${op}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "bad_input");
  // Workspace-only options (where to save results) never reach the provider or the cassette key.
  const { icp: _icp, run_id: _runId, focus, ...providerInput } = parsed.data as Record<string, unknown>;
  // With a focus, fetch the full page for the snapshot and hand the model only the relevant paragraphs.
  const focusMax = op === "fetch_pages" && typeof focus === "string" ? Number(providerInput.max_chars ?? 3000) : null;
  if (focusMax !== null) providerInput.max_chars = 20_000;
  const input = providerInput as OpInputs[O];
  const { ws } = opts;
  const cfg = await loadConfig(ws).catch(() => null);
  const adapter = chooseProvider(op, cfg, availableAdapters(opts), opts.provider);

  // Budget gate (before spending anything).
  const est = estimate(adapter.name, op, input);
  const dayCap = cfg?.budgets.per_day_usd ?? 20;
  const daySpent = spentToday(ws);
  const run = currentRun(ws);
  const runSpent = run ? spentForRun(ws, run.run_id) : null;
  if (daySpent + est > dayCap) {
    throw new ProviderError(`Daily budget reached: $${daySpent.toFixed(2)} of $${dayCap.toFixed(2)} spent; this ${op} would cost ≈ $${est.toFixed(3)}. Ask the user to raise budgets.per_day_usd or continue tomorrow.`, "budget");
  }
  if (run && runSpent !== null && runSpent + est > run.budget_usd) {
    throw new ProviderError(`Run ${run.run_id} budget reached: $${runSpent.toFixed(2)} of $${run.budget_usd.toFixed(2)}; this ${op} would cost ≈ $${est.toFixed(3)}. Stop and report; the user can extend with \`ase ledger run extend\`.`, "budget");
  }
  if (!run && est > UNBUDGETED_CALL_CAP_USD) {
    throw new ProviderError(`This ${op} would cost ≈ $${est.toFixed(2)}, above the $${UNBUDGETED_CALL_CAP_USD} limit for calls outside a run. Start a budgeted run first: \`ase ledger run start --stage <stage> --budget <usd>\`.`, "budget");
  }

  const callId = randomUUID();
  let res;
  try {
    res = await adapter.run(op, input);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`${adapter.name} ${op} failed: ${(e as Error).message}`, "provider_failed");
  }
  appendLedger(ws, { run_id: run?.run_id ?? null, provider: adapter.name, op, usd: res.cost_usd, kind: res.cost_kind, call_id: callId });

  // Post-process: DNC filtering, known-account marking, raw snapshots.
  const dnc = dncMatcher(await loadDnc(ws).catch(() => ({ entries: [] })));
  let dropped = 0;
  let rawRef: string | null = null;
  const meta = { provider: adapter.name, op };
  let results = res.results as OpResults[Op];

  switch (op) {
    case "discover_companies": {
      const hits = (results as OpResults["discover_companies"]).filter((h) => {
        if (h.domain && dnc.domain(h.domain)) return (dropped++, false);
        return true;
      });
      for (const h of hits) h.known = Boolean(h.domain && existsSync(paths.company(ws, h.domain)));
      results = hits;
      rawRef = writeRaw(ws, { ...meta, query: (input as OpInputs["discover_companies"]).query }, hits.map((h) => `- ${h.name} — ${h.url}\n  ${h.description ?? ""}`).join("\n"));
      break;
    }
    case "find_people": {
      const hits = (results as OpResults["find_people"]).filter((h) => {
        if (dnc.linkedin(h.linkedin_url)) return (dropped++, false);
        return true;
      });
      rawRef = writeRaw(ws, { ...meta, query: (input as OpInputs["find_people"]).query }, hits.map((h) => `- ${h.name} — ${h.title ?? "?"} @ ${h.company ?? "?"} — ${h.source_url}`).join("\n"));
      // One snapshot per person (the index's record for that profile), so a citation to the profile stays verifiable.
      results = hits.map((h) => ({
        ...h,
        raw_ref: writeRaw(ws, { ...meta, url: h.linkedin_url ?? h.source_url }, `${h.name}\n${h.title ?? ""}${h.company ? ` @ ${h.company}` : ""}${h.location ? `\n${h.location}` : ""}`),
      }));
      break;
    }
    case "search_news": {
      const hits = (results as OpResults["search_news"]).filter((h) => {
        if (dnc.domain(normalizeDomain(h.url))) return (dropped++, false);
        return true;
      });
      results = hits.map((h) => ({ ...h, raw_ref: writeRaw(ws, { ...meta, url: h.url, title: h.title, published: h.published }, h.summary ?? "") }));
      break;
    }
    case "fetch_pages":
      results = (results as OpResults["fetch_pages"]).map((p) => ({
        ...p,
        raw_ref: writeRaw(ws, { ...meta, url: p.url, title: p.title }, p.text),
        text: focusMax !== null ? focusText(p.text, String(focus), focusMax) : p.text,
      }));
      break;
    case "extract":
      results = (results as OpResults["extract"]).map((x) => ({ ...x, raw_ref: writeRaw(ws, { ...meta, url: x.url }, `\`\`\`json\n${JSON.stringify(x.data, null, 2)}\n\`\`\``) }));
      break;
    case "research": {
      const r = results as OpResults["research"];
      rawRef = writeRaw(
        ws,
        { ...meta, query: (input as OpInputs["research"]).instructions.slice(0, 200) },
        `${r.text ?? ""}\n\n${r.structured ? `\`\`\`json\n${JSON.stringify(r.structured, null, 2)}\n\`\`\`\n\n` : ""}Citations:\n${r.citations.map((c) => `- ${c.url}${c.field ? ` (${c.field})` : ""}`).join("\n")}`,
      );
      break;
    }
  }

  return {
    provider: adapter.name,
    op,
    results: results as OpResults[O],
    cost_usd: res.cost_usd,
    cost_kind: res.cost_kind,
    raw_ref: rawRef,
    dropped_dnc: dropped,
    budget: {
      day_spent_usd: spentToday(ws),
      day_cap_usd: dayCap,
      run_id: run?.run_id ?? null,
      run_spent_usd: run ? spentForRun(ws, run.run_id) : null,
      run_budget_usd: run?.budget_usd ?? null,
    },
  };
}

/** Dry-run: which provider would answer and roughly what it costs. */
export async function estimateCall<O extends Op>(op: O, rawInput: unknown, opts: GatewayOptions): Promise<{ provider: ProviderName; est_usd: number }> {
  const { icp: _icp, run_id: _runId, ...input } = INPUT_SCHEMAS[op].parse(rawInput) as Record<string, unknown>;
  const cfg = await loadConfig(opts.ws).catch(() => null);
  const adapter = chooseProvider(op, cfg, availableAdapters(opts), opts.provider);
  return { provider: adapter.name, est_usd: estimate(adapter.name, op, input as OpInputs[O]) };
}
