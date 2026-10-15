---
name: score
description: Full (re)score of researched accounts against the ICP's current scoring model — after research, after new signals arrive, or after the scoring model changes. Use when the user asks to score, rescore or explain an account's score.
argument-hint: "--icp <slug> [--unattended] [domain ...] [--explain]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Glob, Grep, Agent
---

# Full score

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/references/judging.md`.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

- **Which:** domains in `$ARGUMENTS`, else accounts at stage `researched` (new) and `scored`/`outreach_ready` whose
  `scoring_version` is older than the model's or that have `signals/` with `status: new`.
- **Only weights/tiers changed** since the last score: `ase score recompute --icp <slug>` (no judging needed). Done.
- **Otherwise per account:** run the `factor-judge` agent (mode `full`, today's date, scoring file, and the account's
  company.md, brief.md, signals/, people/ files) → write its JSON to `.ase/tmp/<domain>-full.json` → `ase score compute --icp <slug>
  --account <d> --mode full --judgements <file>`. Set judged signals to `status: scored`.
- **--explain <domain>:** read `accounts/<d>/scores/<slug>.md` and explain the total in plain language: which factors
  carry it, which unknowns cap it (upside vs total), and the one piece of evidence that would move it most.
- Report changes: old → new total and tier, with the factor that moved most.
