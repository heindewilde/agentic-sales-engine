---
name: scoring-design
description: Design, calibrate or revise the scoring model for an ICP — proposes Fit/Intent/Access factors with anchored 0-3 rubrics, back-tests them against your known good and bad customers, checks which factors matter (sensitivity), and versions every change. Use after an ICP is approved, when scores feel wrong, or when outcomes suggest recalibration.
argument-hint: "<icp-slug>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__extract
---

# Design the scoring model

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/scoring.md`,
`icps/<slug>/icp.md` (must be `approved`), `icps/<slug>/known-customers.csv`, `icps/<slug>/calibration/research/`,
existing `icps/<slug>/scoring.yaml` and `calibration.md` if revising, and the learnings files.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (below: `ase`).

## 1. Draft factors (new model) or diagnose (revision)
- New: propose 8–12 factors — about 5 **fit**, 3 **intent**, 2 **access** — derived from the ICP's firmographics,
  technographics, triggers and personas, and above all from the **separating traits** found in the lookalike research.
- Each factor: `id`, `name`, `group`, `weight` (1–5), `question`, four **concrete, observable** anchors (0–3) that two
  judges would apply identically, `evidence_hint`, `light: true` only if judgeable from a homepage + basic
  firmographics, and `knockout: {level_lte: 0}` only for hard exclusions.
- Numeric factors (headcount, revenue, number of sites…) get an `auto` rule so the engine scores them from the fact
  itself — cheaper and perfectly consistent: `auto: { fact: employees, levels: { 0: "<50 | >5000", 1: "50-99", 2: "100-149", 3: "150-700" } }`.
- Time-window intent factors ("a new store/market/investment in the last 12 months") count dated signals instead
  of being re-judged: `auto: { signals: { types: [expansion, funding, mna], within_days: 365 }, levels: { 0: "0", 2: "1", 3: ">=2" } }`.
  Signal types: funding, hiring, exec_change, expansion, mna, launch, partnership, tech_change, news, other.
- Give judged factors one short `examples` line per level where the anchor leaves room for interpretation
  (`examples: { 2: "one new store announced in March", 3: "two stores plus a new country this year" }`). The judge
  and the stability eval both see them; sharper examples are the cheapest way to more consistent scores.
- Present as a table (factor, group, weight, anchors in short, light?, knockout?) and let the user adjust.
- Revision: run `ase score backtest` and `ase score sensitivity` first and start from what they show.

## 2. Write the model
Before editing an existing model: `ase scoring archive --icp <slug>`, then bump `version` and add a `changelog` line
(`{version, date, by, change}`). Write `icps/<slug>/scoring.yaml` (template: `${CLAUDE_PLUGIN_ROOT}/templates/scoring.yaml`);
the hook validates it (group weights sum to 1, every weighted group has factors, unique ids).

## 3. Calibrate against known customers
Need ≥ 3 good and ≥ 2 bad in `known-customers.csv`; if fewer, ask the user for more or run with what exists and say
the result is indicative only.
- Make sure each has a research note in `icps/<slug>/calibration/research/<domain>.md` (run `icp-analyst` for missing
  ones; ask it to cover each factor's `evidence_hint`).
- For each known customer, run the `factor-judge` agent (parallel, ≤ 10 at a time) with today's date, mode `full`, the
  scoring file, and that research note as evidence. Check each returned level against its rationale. Pipe its JSON into:
  `ase score compute --icp <slug> --calibration <domain> --label <good|bad> --mode full --judgements <tmpfile>`
  (write the JSON to `.ase/tmp/<domain>-full.json` first).
- `ase score backtest --icp <slug>` → AUC, median percentile of good customers, misranked accounts, verdict.
- `ase score sensitivity --icp <slug>` → per factor τ for ±20% weight and drop; `dead` and `dominant` flags.

## 4. Iterate (max ~3 rounds unless the user wants more)
- Misranked good customer: which factors pulled it down? Is the anchor wrong, the weight too high, or the evidence missing?
- Misranked bad customer: what made it look good? Often a missing knockout or a fit factor that doesn't discriminate.
- `dead` factor → remove or rewrite its anchors; `dominant` factor → lower its weight unless it truly is decisive.
- Weight / group / tier changes only: `ase score recompute --icp <slug>` (no re-judging needed).
  Anchor or factor changes: re-judge the affected factors for the calibration set.
- Explain each change to the user in one line. Stop at verdict `pass`, or when the user accepts a `weak` model knowingly.

## 5. Record
Write `icps/<slug>/calibration.md`: date, version, back-test numbers, sensitivity table, misranked accounts and why,
changes made per round, known limitations. Add the `calibration` summary (auc, good_median_percentile, verdict,
run_at) to `scoring.yaml`. Suggest `/agentic-sales-engine:discover` next.

Later, when ≥ 30 outcomes are logged (usually via `/agentic-sales-engine:win-loss`): `ase score recalibrate --icp <slug>`
proposes factor weights **and group weights** (fit/intent/access) from what actually engaged. Show both next to the
current values with the coefficients; apply only what the user approves (archive + bump version + edit scoring.yaml +
`ase score recompute`), then re-run the back-test to confirm known customers still rank well.
