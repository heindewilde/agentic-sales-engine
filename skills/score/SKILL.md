---
name: score
description: Rescore accounts against the ICP's current scoring model — after new signals arrive or the scoring model changes (research already scores new accounts), explain a score, or get a second opinion. Use when the user asks to score, rescore or explain an account's score.
argument-hint: "--icp <slug> [--unattended] [domain ...] [--explain]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Glob, Grep, Agent
---

# Rescore

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/references/judging.md`.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

- **Which:** domains in `$ARGUMENTS`, else accounts at stage `scored`/`outreach_ready` whose `scoring_version` is older
  than the model's or that have `signals/` with `status: new`. (Research scores new accounts itself.)
- **Only weights/tiers changed** since the last score: `ase score recompute --icp <slug>` (no judging needed). Done.
- **Otherwise:** `ase context <domains…> --icp <slug> --mode full`, judge every factor in `factors` per `judging.md`
  (auto factors are computed by the engine), write `{"icp":…,"accounts":[{"domain":…,"judgements":[…],"mode":"full"}]}`
  to `.ase/tmp/score-<first-domain>.json` (each judgement shaped as `judging.md` ends) and run
  `ase apply <file>`. For an independent second opinion on a disputed score, use the `factor-judge` agent on that one account.
- **--explain <domain>:** read `accounts/<d>/scores/<slug>.md` and explain the total in plain language: which factors
  carry it, which unknowns cap it (upside vs total), and the one piece of evidence that would move it most.
- Report changes: old → new total and tier, with the factor that moved most.
- **GATE 3:** after a batch of full scores, show the ranking and ask the user to review it before any ways-in or
  outreach work. Record the accounts they confirm with `ase score review --icp <slug> --approved-by <member> <domain…>`,
  then `ways-in` runs on those. Never pass this gate in an unattended run.
