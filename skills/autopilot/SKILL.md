---
name: autopilot
description: Run the whole funnel for an ICP hands-off — discover, light score, shortlist, deep research, full score, ways in and outreach drafts — pausing only at the human gates (shortlist approval, draft review) and staying within one budget. Use when the user wants the engine to "just run", to prospect a new ICP end to end, or to check on, approve or resume a running autopilot.
argument-hint: "start --icp <slug> --budget <usd> [--target N] [--until step] | status | approve | resume | abort"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/autopilot.ts *), Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, AskUserQuestion
---

# Autopilot

CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/autopilot.ts` (`autopilot` below). Steps:
discover → enrich_light → **shortlist (gate 2)** → research → **score (review gate)** → ways_in → **drafts (review)**.
Each step is resumable; state lives in `lists/<icp>/<run>/autopilot.json`; one budget covers the whole run.

## Start
1. Preconditions: the ICP is approved and has a scoring model (`ase doctor`). Provider keys for headless runs must be
   in the shell, the workspace `.env` or `~/.config/agentic-sales-engine/credentials.env` (`ase keys status`).
2. Agree the budget with the user. Rule of thumb: ~$0.03 per discovered account + ~$0.60 per researched account +
   ~$0.60 per drafted account (see the README cost table). Agree `--target` (candidates, default 300) and `--until`
   (default `drafts`; use `shortlist` to stop after the proposal).
3. Run it **in the background** (it takes a while): `autopilot start --icp <slug> --budget <usd> --target <n> --by <member> --text`.
   Tell the user they can keep working; check progress with `autopilot status --text`.

## At a gate
- **Shortlist (gate 2):** show the proposal file (`lists/<icp>/<run>/shortlist.md`): count, cost estimate, the table.
  The user may untick accounts in the file. Ask for approval — never approve on their behalf. On approval:
  `autopilot approve --by <member> --resume --text` (background).
- **Scores:** show the full scores (`ase score rank --icp <slug> --stage scored`), explain surprising ones
  (`/agentic-sales-engine:score --explain <domain>`), let the user correct facts or exclude accounts. Ways in and drafts
  only run after approval, for tier A/B: `autopilot approve --by <member> --resume --text`.
- **Drafts:** list them (`ase drafts list --status draft`), let the user review and edit; remind them nothing was sent.
  Then `autopilot approve --by <member> --text` to close the run.
- **Budget reached:** show spend vs budget; if the user raises it: `ase ledger run extend --budget <usd> --approved-by <member>`,
  then `autopilot resume --text`.

## Extending a run
Started with `--until shortlist` and now want to go further? `autopilot extend --until score --budget <usd> --by <member> --resume --text`
re-enables the later steps and raises the run budget; finished work is kept.

## Failures
`autopilot status --text` shows the failed step and error. Fix the cause (keys, budget, a lint problem), then
`autopilot resume <run-id> --text` — completed steps are not repeated, and work already done on accounts is kept.
