---
name: icp
description: Define or refine an Ideal Customer Profile and its scoring model — analyses your website and materials, researches your best (and worst) customers for lookalike traits, interviews you only on gaps, sanity-checks market size and writes icps/<slug>/icp.md for approval; then designs Fit/Intent/Access factors with anchored 0-3 rubrics, back-tests them against known good and bad customers, checks sensitivity, and versions every change. Use when starting out, entering a new segment, when the user wants to define, review or change who they sell to, after an ICP is approved, when scores feel wrong, or when outcomes suggest recalibration.
argument-hint: "[--icp <slug>] | --scoring --icp <slug> | --recalibrate --icp <slug>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, WebSearch, WebFetch, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__extract, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__discover_companies, mcp__plugin_agentic-sales-engine_ase__estimate, mcp__plugin_agentic-sales-engine_ase__status
---

# ICP and scoring model

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/icp.md`,
`${CLAUDE_PLUGIN_ROOT}/methodology/scoring.md`, `learnings/preferences.md`, `learnings/corrections.md`,
`ase.config.yaml`, and any existing `icps/*/icp.md`. For `--icp <slug>` also read its `known-customers.csv`,
`calibration/research/`, `scoring.yaml` and `calibration.md` if present. Check budget with `ase ledger report`.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (below: `ase`). One-line progress notes between steps.

**Where to start**
- `--recalibrate --icp <slug>` → Recalibrate.
- `--scoring --icp <slug>` → Model, as a revision (ICP must be `approved`).
- Otherwise from where the ICP stands: no ICP, or `--icp` given to refine one → Define; `approved` but no
  `scoring.yaml` → Model; `scoring.yaml` without a `calibration` summary (or verdict not `pass`/accepted) → Calibrate.

## Define (evidence first, questions last — `methodology/icp.md`)

1. **Who are we.** Fetch the website in `ase.config.yaml` (homepage, about, product/solutions, customers/case
   studies, pricing, careers) via `fetch_pages` (T0: WebFetch). Read everything in `company/materials/`. Write
   `company/profile.md` (frontmatter `status: complete`): offering in one line, problems solved, who they claim to
   serve (industries, sizes, roles), proof points and named customers, differentiators, pricing / deal-shape signals,
   geographies. Footnote every claim with its URL or `import:company/materials/<file>`. Note candidate segments — don't
   decide yet.
2. **Lookalikes** (optional, strongly recommended). Ask once: "List 3–10 customers you'd love to clone (name or
   website) — and, if you can, 2–5 that were a bad fit. Skip if you'd rather not." Write them to
   `icps/<slug>/known-customers.csv` (`domain,name,label,note`, label good|bad); before the ICP exists use a short
   provisional slug (e.g. `segment-1`) and keep it. Research each with the `icp-analyst` agent in parallel (≤ 10 at a
   time) into `icps/<slug>/calibration/research/<domain>.md` — do-not-contact customers are fine here. Build a trait
   table (traits × good vs bad): shared traits among good, and separating traits, which become scoring factors.
3. **Gap interview.** AskUserQuestion, at most ~6 optional questions on gaps only (deal size and cycle, who signs and
   champions, geographies now, exclusions and why, why deals are lost, triggers seen before a purchase). Unanswered →
   explicit assumption in the ICP body.
4. **Draft.** Two genuinely different segments (different buyers or problems) → propose separate ICPs. Write
   `icps/<slug>/icp.md` from `${CLAUDE_PLUGIN_ROOT}/templates/icp.md`: `status: draft`, the dimensions, `evidence`
   facts, and 4–12 `discovery_queries` (one per sub-segment × country, phrased like a description of the company you
   want: "family-owned food wholesalers in Flanders with 100–500 employees"). Body: why this segment (cited), how to
   recognise a great fit and a bad fit, assumptions.
5. **Market size.** Estimate matches per geography as `methodology/icp.md` describes (registries/statistics by industry
   code × size band, or sample `discover_companies` queries and extrapolate). Record `market_size` with method and
   verdict; suggest how to adjust if off.
6. **GATE 1.** One-screen summary: segment, size, geographies, personas, triggers, exclusions, market size, top
   assumptions. Ask to approve, edit or reject. On approval set `status: approved`, `approved_by: <member id>`,
   `approved_at: <today>` (the hook refuses approval without an approver). Add existing customers / competitors to the
   do-not-contact list if not yet there (`/agentic-sales-engine:privacy`). Continue to Model — the lookalike research
   is reused there.

## Model (factor design)

1. **New:** propose factors as `methodology/scoring.md` describes, derived from the ICP and the separating traits.
   Show a table (factor, group, weight, anchors in short, light?, knockout?) and let the user adjust.
   **Revision:** run `ase score backtest --icp <slug>` and `ase score sensitivity --icp <slug>` first and start from
   what they show.
2. **Write.** Before editing an existing model: `ase scoring archive --icp <slug>`, bump `version`, add a `changelog`
   line (`{version, date, by, change}`). Write `icps/<slug>/scoring.yaml` (template:
   `${CLAUDE_PLUGIN_ROOT}/templates/scoring.yaml`); the hook validates it.

## Calibrate

1. Use the known customers in `known-customers.csv`; with fewer than `methodology/scoring.md` asks for, ask for more or
   say the result is indicative only. Each needs `calibration/research/<domain>.md` (run `icp-analyst` for missing
   ones, asking it to cover each factor's `evidence_hint`).
2. For each, run the `factor-judge` agent (parallel, ≤ 10 at a time) with today's date, mode `full`, the scoring file
   and that research note as evidence. Check each level against its rationale. Write its JSON to
   `.ase/tmp/<domain>-full.json`, then
   `ase score compute --icp <slug> --calibration <domain> --label <good|bad> --mode full --judgements .ase/tmp/<domain>-full.json`.
3. `ase score backtest --icp <slug>` (AUC, good-customer median percentile, misranked accounts, verdict) and
   `ase score sensitivity --icp <slug>` (τ per factor, `dead` / `dominant` flags).
4. **Iterate** (max ~3 rounds unless the user wants more):
   - Misranked good customer: which factors pulled it down — wrong anchor, weight too high, or missing evidence?
   - Misranked bad customer: what made it look good? Often a missing knockout or a non-discriminating fit factor.
   - `dead` → remove or rewrite anchors; `dominant` → lower its weight unless it truly is decisive.
   - Weight / group / tier changes only: `ase score recompute --icp <slug>`. Anchor or factor changes: re-judge the
     affected factors for the calibration set. Every change goes through Model step 2 (archive + version).
   - Explain each change in one line. Stop at verdict `pass`, or when the user knowingly accepts a `weak` model.
5. **Record.** Write `icps/<slug>/calibration.md`: date, version, back-test numbers, sensitivity table, misranked
   accounts and why, changes per round, known limitations. Add the `calibration` summary (auc,
   good_median_percentile, verdict, run_at) to `scoring.yaml`. Suggest `/agentic-sales-engine:discover` next.

## Recalibrate (outcomes)

Needs the outcome count `methodology/scoring.md` sets (usually logged via `/agentic-sales-engine:outcomes`; patterns
from `outcomes analyze`). `ase score recalibrate --icp <slug>` proposes factor weights **and group weights**. Show both
next to the current values with the coefficients; apply only what the user approves (archive + bump version + edit
`scoring.yaml` + `ase score recompute --icp <slug>`), then re-run the back-test to confirm known customers still rank
well.
