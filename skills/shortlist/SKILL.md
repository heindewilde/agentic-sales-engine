---
name: shortlist
description: GATE 2 — propose which light-scored accounts deserve deep research, with scores, reasons and a cost estimate, and record the team's approval before any deep-research money is spent. Use after light scoring, or when the user asks which accounts to focus on.
argument-hint: "--icp <slug> [--pct <n>] [--max <n>]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, AskUserQuestion
---

# Shortlist (GATE 2)

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md`. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

1. `ase shortlist propose --icp <slug> [--pct N] [--max N]` → writes `lists/<slug>/<run>/shortlist.md` with every
   proposed account ticked `[x]`: the top N% by light score plus high-upside/low-coverage accounts ("research to resolve").
2. Present it compactly: count, cost estimate (typical and p90), the table (domain, name, score, upside, coverage, why),
   and anything notable (clusters by country/sub-segment, accounts that need a knockout check, warm paths if
   `team/*/warm-matches.yaml` mention them).
3. Ask the user to approve as-is, adjust (drop/add domains — edit the ticks in the file for them, or let them edit it),
   or change the percentage. **Never approve on the user's behalf**, and never in an unattended run.
4. On approval: `ase shortlist approve --icp <slug> --file <shortlist.md> --approved-by <member-id>`. It moves the
   ticked accounts to `shortlisted` and returns a suggested research budget. Confirm the budget, then start the run:
   `ase ledger run start --stage research --icp <slug> --budget <usd> --approved-by <member-id>`.
5. Next: `/agentic-sales-engine:research --icp <slug>` (deep research, people, triggers, full score).
