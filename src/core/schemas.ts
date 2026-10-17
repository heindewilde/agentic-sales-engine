import { z } from "zod";

/**
 * Every structured fact in the knowledge base carries its provenance.
 * source_url is an http(s) URL, `user:<member>` (stated by a team member) or `import:<path>` (from a file).
 */
export const SourceRef = z
  .string()
  .min(1)
  .refine((s) => /^https?:\/\/\S+$/i.test(s) || /^user:\S+/.test(s) || /^import:\S+/.test(s), {
    message: "source_url must be an http(s) URL, user:<member> or import:<path>",
  });

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO date or datetime" });

export const Fact = z.object({
  value: z.unknown().refine((v) => v !== undefined && v !== null && v !== "", { message: "value is empty" }),
  source_url: SourceRef,
  retrieved_at: isoDate,
  confidence: z.number().min(0).max(1),
  ttl_days: z.number().int().positive().optional(),
  method: z.enum(["exa", "firecrawl", "web", "import", "user", "llm"]).optional(),
  raw_ref: z.string().optional(),
  note: z.string().optional(),
});
export type Fact = z.infer<typeof Fact>;

/** Funnel stages per account per ICP. Order matters: stages only move forward (except `excluded`). */
export const STAGES = [
  "discovered",
  "light_scored",
  "shortlisted",
  "researched",
  "scored",
  "outreach_ready",
] as const;
export const Stage = z.enum([...STAGES, "excluded"]);
export type Stage = z.infer<typeof Stage>;

export const IcpStatus = z.object({
  stage: Stage,
  light_score: z.number().min(0).max(100).nullable().optional(),
  score: z.number().min(0).max(100).nullable().optional(),
  upside: z.number().min(0).max(100).nullable().optional(),
  coverage: z.number().min(0).max(1).nullable().optional(),
  tier: z.enum(["A", "B", "C", "X"]).nullable().optional(),
  scoring_version: z.number().int().nullable().optional(),
  run_id: z.string().optional(),
  approved_by: z.string().optional(),
  excluded_reason: z.string().optional(),
  updated: isoDate,
});
export type IcpStatus = z.infer<typeof IcpStatus>;

export const Company = z.object({
  id: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "id must be a normalized registrable domain"),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  owner: z.string().optional(),
  dnc: z.boolean().default(false),
  sources: z.array(z.string()).default([]),
  facts: z.record(z.string(), Fact).default({}),
  icp_status: z.record(z.string(), IcpStatus).default({}),
});
export type Company = z.infer<typeof Company>;

export const BRIEF_SECTIONS = [
  "Snapshot",
  "Business & offering",
  "Situation & triggers",
  "Technographics",
  "People map",
  "Ways in",
  "Risks & fit concerns",
  "Open questions",
  "Changelog",
] as const;

export const Brief = z.object({
  account: z.string().min(1),
  sections_updated: z.record(z.string(), isoDate).default({}),
  open_questions: z.number().int().min(0).default(0),
});

export const Person = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  linkedin_url: z.string().url().optional(),
  company: z.string().optional(),
  persona: z.string().optional(),
  seniority: z.enum(["c_level", "vp", "director", "manager", "ic", "owner", "other"]).optional(),
  lawful_basis: z.enum(["legitimate_interest", "consent", "existing_relationship"]).default("legitimate_interest"),
  dnc: z.boolean().default(false),
  facts: z.record(z.string(), Fact).default({}),
  known_by: z
    .array(z.object({ member: z.string(), via: z.string().default("linkedin_connections"), connected_on: z.string().optional() }))
    .default([]),
});
export type Person = z.infer<typeof Person>;

export const SIGNAL_TYPES = [
  "funding", "hiring", "exec_change", "expansion", "mna", "launch", "partnership", "tech_change", "news", "other",
] as const;

export const Signal = z.object({
  account: z.string().min(1),
  type: z.enum(SIGNAL_TYPES),
  title: z.string().min(1),
  date: isoDate,
  source_url: SourceRef,
  retrieved_at: isoDate,
  confidence: z.number().min(0).max(1),
  relevance: z.record(z.string(), z.number().int().min(0).max(3)).default({}),
  ttl_days: z.number().int().positive().default(90),
  status: z.enum(["new", "scored", "stale"]).default("new"),
  raw_ref: z.string().optional(),
});
export type Signal = z.infer<typeof Signal>;

export const Persona = z.object({
  name: z.string(),
  titles: z.array(z.string()).default([]),
  role_in_deal: z.enum(["economic_buyer", "champion", "user", "technical_buyer", "influencer", "blocker"]).optional(),
  jobs: z.array(z.string()).default([]),
  pains: z.array(z.string()).default([]),
  gains: z.array(z.string()).default([]),
});

export const Icp = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  status: z.enum(["draft", "approved", "retired"]),
  version: z.number().int().positive(),
  approved_by: z.string().optional(),
  approved_at: isoDate.optional(),
  offering: z.string().optional(),
  geographies: z.array(z.string()).default([]),
  firmographics: z.record(z.string(), z.unknown()).default({}),
  technographics: z.record(z.string(), z.unknown()).default({}),
  triggers: z.array(z.string()).default([]),
  personas: z.array(Persona).default([]),
  exclusions: z.array(z.string()).default([]),
  discovery_queries: z.array(z.string()).default([]),
  market_size: z
    .object({
      est_accounts: z.number().nullable(),
      method: z.string(),
      verdict: z.enum(["too_narrow", "ok", "too_broad", "unknown"]),
    })
    .optional(),
  evidence: z.array(Fact).default([]),
});
export type Icp = z.infer<typeof Icp>;

export const Level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type Level = z.infer<typeof Level>;

export const Factor = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  group: z.enum(["fit", "intent", "access"]),
  weight: z.number().positive(),
  light: z.boolean().default(false),
  knockout: z.object({ level_lte: Level }).optional(),
  unknown_prior: z.number().min(0).max(3).optional(),
  question: z.string(),
  levels: z.object({ 0: z.string(), 1: z.string(), 2: z.string(), 3: z.string() }),
  evidence_hint: z.string().optional(),
  /** optional worked example per level, shown to every judge: sharper anchors give more consistent levels */
  examples: z.object({ 0: z.string().optional(), 1: z.string().optional(), 2: z.string().optional(), 3: z.string().optional() }).optional(),
  /** rule-based judging from a numeric fact or a count of recent signals — see autojudge.ts */
  auto: z
    .object({
      fact: z.string().optional(),
      signals: z.object({ types: z.array(z.enum(SIGNAL_TYPES)).min(1), within_days: z.number().int().positive() }).optional(),
      levels: z.object({ 0: z.string().optional(), 1: z.string().optional(), 2: z.string().optional(), 3: z.string().optional() }),
    })
    .refine((a) => Boolean(a.fact) !== Boolean(a.signals), { message: "auto needs exactly one of fact or signals" })
    .optional(),
});
export type Factor = z.infer<typeof Factor>;

export const Scoring = z
  .object({
    icp: z.string(),
    version: z.number().int().positive(),
    groups: z.object({ fit: z.number().min(0), intent: z.number().min(0), access: z.number().min(0) }),
    tiers: z.object({ A: z.number(), B: z.number() }).default({ A: 70, B: 50 }),
    /**
     * Groups the total and the tier come from (default: all). Groups left out become a timing label instead
     * (`now` when their score ≥ timing_now, else `later`; `unknown` when nothing in them was judged), so a quiet
     * quarter doesn't sink an account that fits.
     */
    tier_from: z.array(z.enum(["fit", "intent", "access"])).min(1).optional(),
    timing_now: z.number().min(0).max(100).default(50),
    unknown_prior: z.number().min(0).max(3).default(1),
    factors: z.array(Factor).min(1),
    calibration: z.record(z.string(), z.unknown()).optional(),
    changelog: z.array(z.object({ version: z.number(), date: z.string(), by: z.string().optional(), change: z.string() })).default([]),
  })
  .superRefine((s, ctx) => {
    const sum = s.groups.fit + s.groups.intent + s.groups.access;
    if (Math.abs(sum - 1) > 0.001) ctx.addIssue({ code: "custom", message: `group weights must sum to 1 (got ${sum})` });
    const ids = new Set<string>();
    for (const f of s.factors) {
      if (ids.has(f.id)) ctx.addIssue({ code: "custom", message: `duplicate factor id ${f.id}` });
      ids.add(f.id);
    }
    for (const g of ["fit", "intent", "access"] as const) {
      if (s.groups[g] > 0 && !s.factors.some((f) => f.group === g)) {
        ctx.addIssue({ code: "custom", message: `group ${g} has weight but no factors` });
      }
    }
    if (s.tiers.A <= s.tiers.B) ctx.addIssue({ code: "custom", message: "tier A threshold must exceed tier B" });
  });
export type Scoring = z.infer<typeof Scoring>;

export const Evidence = z.object({
  /** the exact words; for a `checked` item: what was looked for and not found on that page */
  quote: z.string().min(1),
  source_url: SourceRef,
  raw_ref: z.string().optional(),
  /** a verified absence: the page at source_url was checked and does not contain what the anchor asks for */
  checked: z.literal(true).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Absence evidence ("checked, none found") can only back level 0; higher levels need a positive quote. */
export const evidenceSupportsLevel = (level: number | null, evidence: { checked?: boolean }[]): boolean =>
  level === null || (level === 0 ? evidence.length > 0 : evidence.some((e) => !e.checked));

export const FactorScore = z
  .object({
    id: z.string(),
    level: Level.nullable(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(Evidence).default([]),
    rationale: z.string().optional(),
  })
  .refine((f) => evidenceSupportsLevel(f.level, f.evidence), {
    message: "a factor with a level must cite evidence (use level: null when unknown); a `checked` absence can only back level 0",
  });
export type FactorScore = z.infer<typeof FactorScore>;

export const ScoreFile = z.object({
  icp: z.string(),
  account: z.string(),
  scoring_version: z.number().int(),
  mode: z.enum(["light", "full"]),
  total: z.number().min(0).max(100),
  upside: z.number().min(0).max(100),
  coverage: z.number().min(0).max(1),
  tier: z.enum(["A", "B", "C", "X"]),
  /** only when the rubric sets tier_from: the groups left out of the tier, as a timing label */
  timing: z.enum(["now", "later", "unknown"]).optional(),
  knocked_out: z.array(z.string()).default([]),
  needs_check: z.array(z.string()).default([]),
  scored_at: isoDate,
  factors: z.array(FactorScore),
  /** only on calibration files (icps/<icp>/calibration/<domain>.md) */
  label: z.enum(["good", "bad"]).optional(),
});
export type ScoreFile = z.infer<typeof ScoreFile>;

export const DncEntry = z.object({
  kind: z.enum(["domain", "email", "linkedin"]),
  value: z.string().min(1),
  reason: z.enum(["customer", "competitor", "partner", "opted_out", "legal", "other"]),
  note: z.string().optional(),
  added: z.string().optional(),
});
export const Dnc = z.object({ entries: z.array(DncEntry).default([]) });
export type Dnc = z.infer<typeof Dnc>;

export const Member = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), email: z.string().optional() });

export const Config = z.object({
  workspace: z.object({ name: z.string(), company: z.string().optional(), website: z.string().optional() }),
  members: z.array(Member).default([]),
  privacy_mode: z.boolean().default(true),
  budgets: z
    .object({
      per_run_usd: z.number().positive().default(5),
      per_day_usd: z.number().positive().default(20),
      deep_research_per_account_usd: z.number().positive().default(0.3),
      /** Exa/Firecrawl only, per researched account (what a subscription user actually pays) */
      research_providers_per_account_usd: z.number().positive().default(0.04),
    })
    .default({ per_run_usd: 5, per_day_usd: 20, deep_research_per_account_usd: 0.3, research_providers_per_account_usd: 0.04 }),
  /** Second opinion on full scores: an independent judge re-scores, a third settles disagreements (reconcile.ts). */
  judging: z
    .object({ second_opinion: z.boolean().default(true), model: z.string().default("sonnet") })
    .default({ second_opinion: true, model: "sonnet" }),
  /** How Claude is paid for. auto: an API key / Bedrock / Vertex means api, otherwise your Claude subscription. */
  claude_billing: z.enum(["auto", "subscription", "api"]).default("auto"),
  /** Subscription plan limits: wait for a reset up to max_wait_minutes inside a batch, else pause; never use paid extra usage unless allowed. */
  usage_limits: z
    .object({ max_wait_minutes: z.number().min(0).default(360), allow_extra_usage: z.boolean().default(false) })
    .default({ max_wait_minutes: 360, allow_extra_usage: false }),
  /** Model per stage. Cheap stages run on Haiku; research, judging and writing stay on Sonnet (quality-checked by evals). */
  models: z
    .object({
      light: z.string().default("haiku"),
      research: z.string().default("sonnet"),
      judge: z.string().default("sonnet"),
      discover: z.string().default("haiku"),
      ways_in: z.string().default("haiku"),
      drafts: z.string().default("sonnet"),
    })
    .default({ light: "haiku", research: "sonnet", judge: "sonnet", discover: "haiku", ways_in: "haiku", drafts: "sonnet" }),
  providers: z
    .object({
      discover: z.enum(["exa", "web"]).default("exa"),
      extract: z.enum(["firecrawl", "exa", "web"]).default("firecrawl"),
      research: z.enum(["exa", "firecrawl", "web"]).default("exa"),
      news: z.enum(["exa", "web"]).default("exa"),
    })
    .default({ discover: "exa", extract: "firecrawl", research: "exa", news: "exa" }),
  ttl_days: z
    .object({ firmographics: z.number().default(180), people: z.number().default(90), signals: z.number().default(90), default: z.number().default(120) })
    .default({ firmographics: 180, people: 90, signals: 90, default: 120 }),
  funnel: z
    .object({ shortlist_pct: z.number().min(1).max(100).default(15), max_deep_research: z.number().int().positive().default(50) })
    .default({ shortlist_pct: 15, max_deep_research: 50 }),
});
export type Config = z.infer<typeof Config>;

/** Format zod issues as short, actionable lines for hook denial messages. */
export function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

// ---------- M7: watchlist (signal monitoring by polling) ----------

export const WatchEntry = z.object({
  account: z.string().min(1),
  icp: z.string(),
  news: z.boolean().default(true),
  /** extra words to make the news query specific (e.g. "Ghent wholesaler"); defaults to the company name only */
  news_query: z.string().optional(),
  pages: z.array(z.string().url()).default([]),
  added_by: z.string().optional(),
  added: z.string().optional(),
  last_news_check: z.string().optional(),
  /** url -> sha of normalized page text at the last check */
  page_hashes: z.record(z.string(), z.string()).default({}),
  /** short hashes of news URLs already reported, newest last (capped) */
  seen: z.array(z.string()).default([]),
});
export type WatchEntry = z.infer<typeof WatchEntry>;
export const Watchlist = z.object({ entries: z.array(WatchEntry).default([]) });
export type Watchlist = z.infer<typeof Watchlist>;

// ---------- M8: outreach drafts ----------

export const Draft = z.object({
  account: z.string().min(1),
  icp: z.string(),
  person: z.string().optional(),
  person_linkedin: z.string().optional(),
  channel: z.enum(["email", "linkedin_connect", "linkedin_dm", "intro_request"]),
  step: z.number().int().min(1).default(1),
  status: z.enum(["draft", "edited", "sent", "discarded"]).default("draft"),
  way_in: z.string().optional(),
  based_on: z.array(z.string()).min(1, "list the brief sections / signals / people files this draft relies on"),
  created: isoDate,
  sent_at: isoDate.optional(),
  learned: z.boolean().default(false),
});
export type Draft = z.infer<typeof Draft>;

// ---------- M9: call prep ----------

export const CallPrep = z.object({
  account: z.string().min(1),
  icp: z.string(),
  meeting_date: isoDate.optional(),
  attendees: z.array(z.object({ name: z.string(), person: z.string().optional(), role: z.string().optional() })).default([]),
  objective: z.string().optional(),
  created: isoDate,
  sources_checked_at: isoDate,
});
export type CallPrep = z.infer<typeof CallPrep>;
