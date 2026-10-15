---
name: log-outcome
description: Record what happened with a prospect — meeting booked, opportunity, won, lost, no response, disqualified — so the engine learns which scores actually predict success. Use when the user reports a reply, meeting, deal result or that an account was a bad fit.
argument-hint: "<domain> <meeting|opportunity|won|lost|no_response|disqualified> [note]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit
---

# Log an outcome

1. Resolve the account (domain) and ICP (ask if the account is scored for more than one ICP).
2. `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts outcome log <domain> <outcome> --icp <slug> --member <id> --note "<short note>"`.
3. Add a dated Changelog line to the account's `brief.md`.
4. If the note reveals *why* (e.g. "lost: they're mid-ERP-migration until 2027", "disqualified: centralized AP abroad"),
   ask whether it should become a learning or a rubric change, and offer `/agentic-sales-engine:learn` or
   `/agentic-sales-engine:scoring-design`.
5. If the person asked not to be contacted again, add them to the do-not-contact list.
6. Show progress: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts outcomes stats --icp <slug>` (engagement by tier, and how
   close recalibration is). Suggest `/agentic-sales-engine:win-loss` after every ~10 new outcomes.
