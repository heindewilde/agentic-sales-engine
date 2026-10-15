import { z } from "zod";
import { parseDoc, parseYaml } from "./frontmatter.ts";
import { isPersonalEmail, normalizeDomain, normalizeLinkedIn } from "./normalize.ts";
import {
  BRIEF_SECTIONS, Brief, CallPrep, Company, Config, Dnc, Draft, Icp, Person, ScoreFile, Scoring, Signal, Watchlist, formatIssues,
} from "./schemas.ts";
import type { DncMatcher } from "./workspace.ts";

export type EntityKind =
  | "company" | "brief" | "score" | "calibration" | "signal" | "person" | "icp" | "scoring" | "config" | "dnc" | "raw"
  | "watchlist" | "draft" | "draft_original" | "callprep" | "voice" | "other";

/** Classify a workspace-relative path into the entity it holds. */
export function classify(rel: string): { kind: EntityKind; account?: string; icp?: string } {
  let m: RegExpExecArray | null;
  if (rel.startsWith("raw/")) return { kind: "raw" };
  if (rel === "ase.config.yaml") return { kind: "config" };
  if (rel === "dnc.yaml") return { kind: "dnc" };
  if (rel === "watchlist.yaml") return { kind: "watchlist" };
  if (rel === "company/voice/profile.md") return { kind: "voice" };
  if ((m = /^accounts\/([^/]+)\/drafts\/\.originals\/[^/]+\.md$/.exec(rel))) return { kind: "draft_original", account: m[1] };
  if ((m = /^accounts\/([^/]+)\/drafts\/[^/]+\.md$/.exec(rel))) return { kind: "draft", account: m[1] };
  if ((m = /^accounts\/([^/]+)\/callprep\/[^/]+\.md$/.exec(rel))) return { kind: "callprep", account: m[1] };
  if ((m = /^accounts\/([^/]+)\/company\.md$/.exec(rel))) return { kind: "company", account: m[1] };
  if ((m = /^accounts\/([^/]+)\/brief\.md$/.exec(rel))) return { kind: "brief", account: m[1] };
  if ((m = /^accounts\/([^/]+)\/scores\/([^/]+)\.md$/.exec(rel))) return { kind: "score", account: m[1], icp: m[2] };
  if ((m = /^accounts\/([^/]+)\/signals\/[^/]+\.md$/.exec(rel))) return { kind: "signal", account: m[1] };
  if ((m = /^accounts\/([^/]+)\//.exec(rel))) return { kind: "other", account: m[1] };
  if (/^people\/[^/]+\.md$/.test(rel)) return { kind: "person" };
  if ((m = /^icps\/([^/]+)\/icp\.md$/.exec(rel))) return { kind: "icp", icp: m[1] };
  if ((m = /^icps\/([^/]+)\/scoring\.yaml$/.exec(rel))) return { kind: "scoring", icp: m[1] };
  if ((m = /^icps\/([^/]+)\/calibration\/([^/]+)\.md$/.exec(rel))) return { kind: "calibration", icp: m[1] };
  return { kind: "other" };
}

export interface ValidateOpts {
  privacyMode: boolean;
  dnc?: DncMatcher;
  /** true when the file already exists on disk (raw/ snapshots are write-once). */
  exists?: boolean;
}

/** GDPR special-category and clearly-private keys we never store about a person. */
const FORBIDDEN_PERSON_KEYS = /^(personal_email|private_email|home_address|address_home|date_of_birth|dob|birthday|age|religion|ethnicity|race|health|medical|political|sexual_orientation|trade_union|marital_status|children|personal_phone|mobile_personal)$/i;

function zodErrors(schema: z.ZodType, data: unknown, label: string): string[] {
  const r = schema.safeParse(data);
  return r.success ? [] : [`${label} frontmatter is invalid:\n${formatIssues(r.error)}`];
}

/** Every [^ref] used in the body must have a definition, and every definition must carry a source. */
export function checkFootnotes(body: string): string[] {
  const errors: string[] = [];
  const defs = new Map<string, string>();
  for (const m of body.matchAll(/^\[\^([^\]]+)\]:\s*(.+)$/gm)) defs.set(m[1]!, m[2]!);
  const used = new Set<string>();
  for (const m of body.matchAll(/\[\^([^\]]+)\](?!:)/g)) used.add(m[1]!);
  for (const u of used) if (!defs.has(u)) errors.push(`footnote [^${u}] is used but never defined`);
  for (const [k, v] of defs) {
    if (!/(https?:\/\/\S+|user:\S+|import:\S+)/.test(v)) errors.push(`footnote [^${k}] has no source URL (or user:/import: reference)`);
  }
  return errors;
}

/** Validate the full proposed content of a workspace file. Returns human-readable errors (empty = OK). */
export function validateContent(rel: string, content: string, opts: ValidateOpts): string[] {
  const c = classify(rel);
  const errors: string[] = [];

  if (c.kind === "raw") {
    if (opts.exists) errors.push("raw/ snapshots are immutable; write a new snapshot instead of modifying an existing one");
    return errors;
  }

  if (c.account && opts.dnc?.domain(c.account)) {
    errors.push(`${c.account} is on the do-not-contact list (${opts.dnc.reason("domain", c.account)}); no account files may be written for it`);
    return errors;
  }

  const isYaml = rel.endsWith(".yaml") || rel.endsWith(".yml");
  let data: Record<string, unknown> = {};
  let body = "";
  try {
    if (isYaml) data = (parseYaml<Record<string, unknown>>(content) ?? {}) as Record<string, unknown>;
    else if (rel.endsWith(".md")) ({ data, body } = parseDoc(content));
  } catch (e) {
    return [`could not parse ${isYaml ? "YAML" : "frontmatter"}: ${(e as Error).message}`];
  }

  switch (c.kind) {
    case "company": {
      errors.push(...zodErrors(Company, data, "company"));
      if (data.id && data.id !== c.account) errors.push(`id "${data.id}" must match the folder name "${c.account}"`);
      if (c.account && normalizeDomain(c.account) !== c.account) errors.push(`folder "${c.account}" is not a normalized registrable domain`);
      errors.push(...checkFootnotes(body));
      break;
    }
    case "brief": {
      errors.push(...zodErrors(Brief, data, "brief"));
      const missing = BRIEF_SECTIONS.filter((s) => !new RegExp(`^##\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(body));
      if (missing.length) errors.push(`brief is missing required sections: ${missing.map((s) => `"## ${s}"`).join(", ")}`);
      errors.push(...checkFootnotes(body));
      break;
    }
    case "score":
      errors.push(...zodErrors(ScoreFile, data, "score"));
      if (data.icp && data.icp !== c.icp) errors.push(`icp "${data.icp}" must match file name "${c.icp}"`);
      if (data.account && data.account !== c.account) errors.push(`account "${data.account}" must match folder "${c.account}"`);
      break;
    case "calibration":
      errors.push(...zodErrors(ScoreFile, data, "calibration score"));
      if (!data.label) errors.push("calibration scores need label: good | bad");
      if (data.icp && data.icp !== c.icp) errors.push(`icp "${data.icp}" must match folder "${c.icp}"`);
      break;
    case "signal":
      errors.push(...zodErrors(Signal, data, "signal"));
      if (data.account && data.account !== c.account) errors.push(`account "${data.account}" must match folder "${c.account}"`);
      break;
    case "person": {
      errors.push(...zodErrors(Person, data, "person"));
      const facts = (data.facts ?? {}) as Record<string, { value?: unknown }>;
      const keys = [...Object.keys(data), ...Object.keys(facts)];
      const bad = keys.filter((k) => FORBIDDEN_PERSON_KEYS.test(k));
      if (bad.length) errors.push(`personal data that is not business-relevant may not be stored: ${bad.join(", ")}`);
      if (opts.privacyMode) {
        for (const [k, f] of Object.entries(facts)) {
          if (typeof f?.value === "string" && f.value.includes("@") && isPersonalEmail(f.value)) {
            errors.push(`facts.${k} is a personal mailbox (${f.value.split("@")[1]}); privacy mode only allows business email addresses`);
          }
        }
      }
      if (opts.dnc) {
        if (opts.dnc.linkedin(data.linkedin_url as string)) errors.push("this person is on the do-not-contact list");
        if (opts.dnc.domain(data.company as string)) errors.push(`this person's company ${data.company} is on the do-not-contact list`);
      }
      if (data.linkedin_url && !normalizeLinkedIn(data.linkedin_url as string)) errors.push("linkedin_url is not a LinkedIn profile URL");
      errors.push(...checkFootnotes(body));
      break;
    }
    case "icp":
      errors.push(...zodErrors(Icp, data, "icp"));
      if (data.slug && data.slug !== c.icp) errors.push(`slug "${data.slug}" must match folder "${c.icp}"`);
      if (data.status === "approved" && !data.approved_by) errors.push("an approved ICP needs approved_by (GATE 1 is a human decision)");
      errors.push(...checkFootnotes(body));
      break;
    case "scoring":
      errors.push(...zodErrors(Scoring, data, "scoring.yaml"));
      if (data.icp && data.icp !== c.icp) errors.push(`icp "${data.icp}" must match folder "${c.icp}"`);
      break;
    case "watchlist":
      errors.push(...zodErrors(Watchlist, data, "watchlist.yaml"));
      break;
    case "draft": {
      errors.push(...zodErrors(Draft, data, "draft"));
      if (data.account && data.account !== c.account) errors.push(`account "${data.account}" must match folder "${c.account}"`);
      if (opts.dnc && opts.dnc.linkedin(data.person_linkedin as string | undefined)) errors.push("the recipient is on the do-not-contact list");
      const fn = checkFootnotes(body);
      errors.push(...fn);
      // Claims about the prospect must be traceable: a first-touch message needs at least one cited fact.
      if (data.channel !== "intro_request" && !/\[\^[^\]]+\]/.test(body)) errors.push("cite at least one fact about the prospect with a footnote ([^1]: <source>) — drafts must be grounded in the brief");
      break;
    }
    case "draft_original":
      if (opts.exists) errors.push("draft originals are write-once; they are the baseline for learning from your edits");
      break;
    case "callprep":
      errors.push(...zodErrors(CallPrep, data, "call prep"));
      if (data.account && data.account !== c.account) errors.push(`account "${data.account}" must match folder "${c.account}"`);
      errors.push(...checkFootnotes(body));
      break;
    case "voice":
      errors.push(...checkFootnotes(body));
      break;
    case "config":
      errors.push(...zodErrors(Config, data, "ase.config.yaml"));
      break;
    case "dnc":
      errors.push(...zodErrors(Dnc, data, "dnc.yaml"));
      break;
    case "other":
      if (rel.endsWith(".md")) errors.push(...checkFootnotes(body));
      break;
  }
  return errors;
}
