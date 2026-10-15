import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { canTransition } from "./contracts.ts";
import { parseYaml, readDoc, stringifyDoc } from "./frontmatter.ts";
import { normalizeDomain } from "./normalize.ts";
import { FactorScore, Scoring, type Company, type ScoreFile } from "./schemas.ts";
import { backtest, computeScore, recalibrate, sanitizeJudgements, sensitivity, type LabeledAccount, type Mode } from "./score.ts";
import { validateContent } from "./validate.ts";
import { dncMatcher, loadConfig, loadDnc, paths, today } from "./workspace.ts";

export const calibrationPath = (ws: string, icp: string, domain: string) => join(ws, "icps", icp, "calibration", `${domain}.md`);

export async function loadScoring(ws: string, icp: string): Promise<Scoring> {
  const p = paths.scoring(ws, icp);
  if (!existsSync(p)) throw new Error(`icps/${icp}/scoring.yaml does not exist — run scoring-design first`);
  return Scoring.parse(parseYaml(readFileSync(p, "utf8")));
}

function renderBody(scoring: Scoring, file: ScoreFile, label?: string): string {
  const name = new Map(scoring.factors.map((f) => [f.id, f]));
  const rows = file.factors.map((f) => {
    const fac = name.get(f.id);
    const lvl = f.level === null ? "unknown" : `${f.level} — ${fac?.levels[f.level as 0 | 1 | 2 | 3] ?? ""}`;
    const ev = f.evidence.map((e) => `"${e.quote.replace(/\|/g, "/").slice(0, 140)}" (${e.source_url})`).join("<br>") || "—";
    return `| ${fac?.name ?? f.id} | ${fac?.group ?? ""} | ${lvl} | ${f.confidence} | ${ev} |`;
  });
  return [
    `# ${file.account} — ${file.icp} (${file.mode} score v${file.scoring_version})${label ? ` — calibration: ${label}` : ""}`,
    "",
    `**Total ${file.total}** · upside ${file.upside} · coverage ${Math.round(file.coverage * 100)}% · tier **${file.tier}**` +
      (file.knocked_out.length ? ` · knocked out by ${file.knocked_out.join(", ")}` : "") +
      (file.needs_check.length ? ` · needs check: ${file.needs_check.join(", ")}` : ""),
    "",
    "| Factor | Group | Level | Conf. | Evidence |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...file.factors.filter((f) => f.rationale).map((f) => `- **${name.get(f.id)?.name ?? f.id}:** ${f.rationale}`),
    "",
  ].join("\n");
}

export interface WriteScoreArgs {
  ws: string;
  icp: string;
  domain: string;
  mode: Mode;
  judgements: unknown;
  /** calibration label → writes to icps/<icp>/calibration/<domain>.md instead of the account */
  calibration?: "good" | "bad";
}

/** Validate judge output, compute the score, write the score file and (for accounts) advance the company's ICP status. */
export async function writeScore(a: WriteScoreArgs) {
  const scoring = await loadScoring(a.ws, a.icp);
  const domain = normalizeDomain(a.domain) ?? a.domain;
  const raw = Array.isArray(a.judgements) ? a.judgements : (a.judgements as { factors?: unknown[] })?.factors;
  if (!Array.isArray(raw)) throw new Error("judgements must be an array of {id, level, confidence, evidence, rationale}");
  const known = new Set(scoring.factors.map((f) => f.id));
  // Judges sometimes send empty optional fields; drop them rather than fail validation.
  for (const r of raw as { evidence?: { raw_ref?: string }[] }[]) for (const e of r?.evidence ?? []) if (e && !e.raw_ref) delete e.raw_ref;
  const parsed = raw.map((r, i) => {
    const res = FactorScore.safeParse(r);
    // The judge's level-without-evidence is downgraded to unknown rather than rejected.
    if (!res.success) {
      const loose = r as Partial<FactorScore>;
      if (loose?.id && (loose.level === 0 || loose.level === 1 || loose.level === 2 || loose.level === 3) && !loose.evidence?.length) {
        return { id: loose.id, level: null, confidence: 0, evidence: [], rationale: `${loose.rationale ?? ""} [no evidence → unknown]`.trim() };
      }
      throw new Error(`judgement ${i} is invalid: ${res.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    }
    return res.data;
  });
  const unknownIds = parsed.filter((p) => !known.has(p.id)).map((p) => p.id);
  if (unknownIds.length) throw new Error(`unknown factor ids: ${unknownIds.join(", ")} (scoring v${scoring.version} has ${[...known].join(", ")})`);
  const judged = sanitizeJudgements(parsed);
  // Fill in factors the judge skipped as explicit unknowns so the file shows the full rubric.
  const factorIds = (a.mode === "light" ? scoring.factors.filter((f) => f.light) : scoring.factors).map((f) => f.id);
  for (const id of factorIds) if (!judged.some((j) => j.id === id)) judged.push({ id, level: null, confidence: 0, evidence: [], rationale: "not judged" });
  const ordered = factorIds.map((id) => judged.find((j) => j.id === id)!);

  const r = computeScore(scoring, ordered, a.mode);
  const file: ScoreFile & { label?: string } = {
    icp: a.icp,
    account: domain,
    scoring_version: scoring.version,
    mode: a.mode,
    total: r.total,
    upside: r.upside,
    coverage: r.coverage,
    tier: r.tier,
    knocked_out: r.knocked_out,
    needs_check: r.needs_check,
    scored_at: new Date().toISOString(),
    factors: ordered,
  };
  if (a.calibration) file.label = a.calibration;
  const target = a.calibration ? calibrationPath(a.ws, a.icp, domain) : paths.score(a.ws, domain, a.icp);
  const rel = target.slice(a.ws.length + 1);
  const content = stringifyDoc(file, renderBody(scoring, file, a.calibration));
  const cfg = await loadConfig(a.ws).catch(() => null);
  const dnc = a.calibration ? undefined : dncMatcher(await loadDnc(a.ws).catch(() => ({ entries: [] })));
  const errs = validateContent(rel, content, { privacyMode: cfg?.privacy_mode ?? true, dnc });
  if (errs.length) throw new Error(`refusing to write ${rel}:\n${errs.join("\n")}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);

  let stage: string | null = null;
  if (!a.calibration) stage = await advanceCompany(a.ws, domain, a.icp, a.mode, r, scoring.version);
  return { path: rel, ...r, stage, scoring_version: scoring.version };
}

async function advanceCompany(ws: string, domain: string, icp: string, mode: Mode, r: ReturnType<typeof computeScore>, version: number): Promise<string | null> {
  const p = paths.company(ws, domain);
  if (!existsSync(p)) return null;
  const { data, body } = await readDoc<Company>(p);
  const prev = data.icp_status?.[icp];
  const st = { ...(prev ?? { stage: "discovered" as const, updated: today() }) };
  if (mode === "light") st.light_score = r.total;
  else st.score = r.total;
  st.upside = r.upside;
  st.coverage = r.coverage;
  st.tier = r.tier;
  st.scoring_version = version;
  st.updated = today();
  if (r.knocked_out.length && canTransition(st.stage, "excluded")) {
    st.stage = "excluded";
    st.excluded_reason = `knocked out by ${r.knocked_out.join(", ")} (${mode} score)`;
  } else if (mode === "light" && st.stage === "discovered") st.stage = "light_scored";
  else if (mode === "full" && (st.stage === "researched" || st.stage === "scored")) st.stage = "scored";
  data.icp_status = { ...(data.icp_status ?? {}), [icp]: st };
  writeFileSync(p, stringifyDoc(data, body));
  return st.stage;
}

function readScoreDoc(path: string): (ScoreFile & { label?: "good" | "bad" }) | null {
  try {
    const text = readFileSync(path, "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    return m ? (parseYaml(m[1]!) as ScoreFile & { label?: "good" | "bad" }) : null;
  } catch {
    return null;
  }
}

/** Labeled calibration accounts plus (optionally) every scored prospect as the unlabeled population. */
export function loadCalibrationSet(ws: string, icp: string, opts: { includeProspects: boolean; mode?: Mode }): LabeledAccount[] {
  const out: LabeledAccount[] = [];
  const cdir = join(ws, "icps", icp, "calibration");
  if (existsSync(cdir)) {
    for (const f of readdirSync(cdir).filter((x) => x.endsWith(".md"))) {
      const s = readScoreDoc(join(cdir, f));
      if (s && (!opts.mode || s.mode === opts.mode)) out.push({ domain: s.account, label: s.label ?? null, judged: s.factors });
    }
  }
  if (opts.includeProspects) {
    const adir = join(ws, "accounts");
    for (const d of existsSync(adir) ? readdirSync(adir) : []) {
      const s = readScoreDoc(paths.score(ws, d, icp));
      if (s && (!opts.mode || s.mode === opts.mode)) out.push({ domain: d, label: null, judged: s.factors });
    }
  }
  return out;
}

/** Labels from icps/<icp>/known-customers.csv (columns: domain,name,label[,note]). */
export function loadKnownCustomers(ws: string, icp: string): { domain: string; name: string; label: "good" | "bad"; note?: string }[] {
  const p = join(ws, "icps", icp, "known-customers.csv");
  if (!existsSync(p)) return [];
  const rows = parseCsv(readFileSync(p, "utf8"), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows
    .map((r) => ({ domain: normalizeDomain(r.domain ?? r.website ?? "") ?? "", name: r.name ?? "", label: (r.label ?? "").toLowerCase() as "good" | "bad", note: r.note }))
    .filter((r) => r.domain && (r.label === "good" || r.label === "bad"));
}

export async function runBacktest(ws: string, icp: string, mode: Mode = "full") {
  const scoring = await loadScoring(ws, icp);
  const set = loadCalibrationSet(ws, icp, { includeProspects: true, mode });
  const known = loadKnownCustomers(ws, icp);
  const missing = known.filter((k) => !existsSync(calibrationPath(ws, icp, k.domain))).map((k) => k.domain);
  return { scoring_version: scoring.version, mode, ...backtest(scoring, set, mode), not_yet_judged: missing };
}

export async function runSensitivity(ws: string, icp: string, mode: Mode = "full") {
  const scoring = await loadScoring(ws, icp);
  const set = loadCalibrationSet(ws, icp, { includeProspects: true, mode });
  if (set.length < 4) throw new Error(`need at least 4 scored accounts for sensitivity (have ${set.length})`);
  return { scoring_version: scoring.version, mode, n: set.length, factors: sensitivity(scoring, set, mode) };
}

export interface RankRow {
  domain: string;
  name: string;
  stage: string;
  mode: Mode;
  total: number;
  upside: number;
  coverage: number;
  tier: string;
  needs_check: string[];
  knocked_out: string[];
  research_to_resolve: boolean;
  owner?: string;
}

/** Rank prospects for an ICP from their score files (shortlist input). */
export async function rank(ws: string, icp: string, opts: { stage?: string; limit?: number } = {}): Promise<RankRow[]> {
  const adir = join(ws, "accounts");
  const rows: RankRow[] = [];
  for (const d of existsSync(adir) ? readdirSync(adir) : []) {
    const cp = paths.company(ws, d);
    if (!existsSync(cp)) continue;
    const { data } = await readDoc<Company>(cp);
    const st = data.icp_status?.[icp];
    if (!st || data.dnc) continue;
    if (opts.stage && st.stage !== opts.stage) continue;
    const s = readScoreDoc(paths.score(ws, d, icp));
    if (!s) continue;
    rows.push({
      domain: d, name: data.name, stage: st.stage, mode: s.mode, total: s.total, upside: s.upside, coverage: s.coverage, tier: s.tier,
      needs_check: s.needs_check ?? [], knocked_out: s.knocked_out ?? [], owner: data.owner,
      research_to_resolve: s.coverage < 0.5 && s.upside - s.total >= 20,
    });
  }
  rows.sort((a, b) => (a.tier === "X" ? 1 : 0) - (b.tier === "X" ? 1 : 0) || b.total - a.total || b.upside - a.upside);
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

const POSITIVE = new Set(["meeting", "opportunity", "won"]);

export async function runRecalibrate(ws: string, icp: string) {
  const scoring = await loadScoring(ws, icp);
  const p = join(ws, "outcomes", "outcomes.csv");
  const rows = existsSync(p) ? (parseCsv(readFileSync(p, "utf8"), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[]) : [];
  // Latest outcome per account for this ICP.
  const latest = new Map<string, string>();
  for (const r of rows.filter((r) => r.icp === icp).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) latest.set(r.account ?? "", r.outcome ?? "");
  const data: { judged: { id: string; level: 0 | 1 | 2 | 3 | null }[]; positive: boolean }[] = [];
  for (const [domain, outcome] of latest) {
    const s = readScoreDoc(paths.score(ws, domain, icp));
    if (s?.mode === "full") data.push({ judged: s.factors, positive: POSITIVE.has(outcome) });
  }
  const positives = data.filter((d) => d.positive).length;
  if (data.length < 30 || positives < 5 || data.length - positives < 5) {
    return { ready: false, n: data.length, positives, message: "Need ≥30 fully-scored accounts with logged outcomes, including ≥5 positive and ≥5 negative, before recalibrating." };
  }
  return { ready: true, n: data.length, positives, scoring_version: scoring.version, proposal: recalibrate(scoring, data) };
}

/**
 * Re-score every calibration and account score file for an ICP from its stored factor judgements —
 * used after weights, groups or tiers change (no new LLM judging needed). Anchor (level wording)
 * changes do need re-judging; the scoring-design skill handles that.
 */
export async function recomputeAll(ws: string, icp: string) {
  const results: { path: string; total: number; tier: string }[] = [];
  const cdir = join(ws, "icps", icp, "calibration");
  for (const f of existsSync(cdir) ? readdirSync(cdir).filter((x) => x.endsWith(".md")) : []) {
    const s = readScoreDoc(join(cdir, f));
    if (!s?.label) continue;
    const r = await writeScore({ ws, icp, domain: s.account, mode: s.mode, judgements: s.factors, calibration: s.label });
    results.push({ path: r.path, total: r.total, tier: r.tier });
  }
  const adir = join(ws, "accounts");
  for (const d of existsSync(adir) ? readdirSync(adir) : []) {
    const s = readScoreDoc(paths.score(ws, d, icp));
    if (!s) continue;
    const r = await writeScore({ ws, icp, domain: d, mode: s.mode, judgements: s.factors });
    results.push({ path: r.path, total: r.total, tier: r.tier });
  }
  return { recomputed: results.length, results };
}

/** Copy the current scoring.yaml to scoring.history/v<version>.yaml (before editing it). */
export async function archiveScoring(ws: string, icp: string) {
  const scoring = await loadScoring(ws, icp);
  const dest = join(ws, "icps", icp, "scoring.history", `v${scoring.version}.yaml`);
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) writeFileSync(dest, readFileSync(paths.scoring(ws, icp), "utf8"));
  return { archived: dest.slice(ws.length + 1), version: scoring.version, next_version: scoring.version + 1 };
}
