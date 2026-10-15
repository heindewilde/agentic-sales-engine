---
name: win-loss
description: Learn from what actually happened — reviews logged outcomes (meetings, wins, losses, disqualifications, silence) against how accounts were scored and why, finds patterns, and proposes concrete changes to the ICP, the scoring rubric and its weights for the team to approve. Use periodically (e.g. monthly), after a batch of outcomes, or when the user asks why deals are won or lost or whether the scoring works.
argument-hint: "--icp <slug> [--since YYYY-MM-DD]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# Win-loss review

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/scoring.md`,
`icps/<slug>/icp.md`, `icps/<slug>/scoring.yaml`, `icps/<slug>/calibration.md`, `learnings/*.md`, and earlier reviews
in `icps/<slug>/win-loss/`. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

## 1. The numbers (honest about sample size)
`ase outcomes stats --icp <slug>` → engagement rate (positive reply or better) by tier, trigger type and channel, each
with a 95% interval; loss-reason counts; median score of engaged vs non-engaged accounts; the tier signal;
recalibration readiness. Only resolved accounts count (outreach still in flight is excluded).
Report rates **with their intervals** ("tier A: 4/9 engaged, 19–73%"). Never call a difference real when intervals
overlap; say what more data would settle it. Under ~10 outcomes, treat everything as anecdote.

## 2. The stories
`ase outcomes cases --icp <slug> [--since <date>]` → each resolved account's status, engaged/won, reason codes, notes,
event history, channels, tier, factor levels, signal types and brief path. Silence derived from the 21-day rule is
flagged (`derived_no_response`) — weigh it lighter than an explicit "not interested". Read the notes, and for losses/disqualifications/wins also the brief's Risks and Ways in.
Look for patterns across ≥ 3 accounts (one case is an anecdote):
- **False positives** (high tier, lost/disqualified/no response): which factor was high but misleading? Missing
  exclusion or knockout? (e.g. "AP centralised in a foreign HQ", "just renewed a competitor")
- **False negatives** (low tier, engaged/won): which factor undervalued them? A trait the rubric doesn't capture?
- **Triggers:** which signal types precede engagement; which don't move anything.
- **Ways in:** warm intros vs cold triggers vs channel — from drafts sent and notes.
- **Silence vs rejection:** many `no_response` with few `not_interested` points at messaging, channel or the wrong
  persona, not at the ICP. Compare channels (`by_channel`).
- **Loss reasons:** clusters of `not_icp` / `no_pain` → ICP or rubric; `wrong_person` → personas; `timing` → triggers;
  `competitor` → add a factor or exclusion for the incumbent.

## 3. Proposals (never applied without approval)
Write `icps/<slug>/win-loss/<YYYY-MM-DD>.md`: the numbers, the patterns (each citing the accounts, e.g.
`import:accounts/x.com/brief.md`, and outcome notes as `import:outcomes/outcomes.csv`), and a numbered list of
proposals, each typed:
- **ICP change** (exclusion, persona, trigger, geography) → apply via `/agentic-sales-engine:icp-build` (new version, re-approval).
- **Rubric change** (anchor wording, new factor, knockout) → apply via `/agentic-sales-engine:scoring-design`
  (archive, bump version, re-judge affected factors, back-test).
- **Weight change** → if recalibration is ready, include `ase score recalibrate --icp <slug>` output side by side with
  current weights; apply via scoring-design + `ase score recompute`.
- **Process/messaging lesson** → `learnings/preferences.md` (via `/agentic-sales-engine:learn`) or the voice profile.
Ask the user which proposals to accept (AskUserQuestion, multi-select), then hand each accepted one to the skill
named above. Record decisions at the bottom of the review file.
