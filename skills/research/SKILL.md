---
name: research
description: Deep research on approved (shortlisted) accounts — triggers, buying committee, systems, fit risks — followed by the full score. Use after the shortlist is approved, or when the user asks to research specific accounts in depth.
argument-hint: "--icp <slug> [--unattended] [domain ...]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts *), Read, Write, Edit, Glob, Grep, Agent, WebSearch, WebFetch, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__extract, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__find_people, mcp__plugin_agentic-sales-engine_ase__research, mcp__plugin_agentic-sales-engine_ase__estimate, mcp__plugin_agentic-sales-engine_ase__status
---

# Deep research (deep funnel)

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md`. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

1. **Accounts:** domains in `$ARGUMENTS`, else `ase accounts --icp <slug> --stage shortlisted`. Research only
   accounts that passed GATE 2 (stage `shortlisted` with `approved_by`) — if the user names others, run the shortlist
   gate for them first.
2. **Budget:** there should be an active run from the shortlist approval (`ase ledger report`). If not, propose one
   (`budgets.deep_research_per_account_usd` × accounts) and start it after the user agrees
   (`ase ledger run start --stage research --icp <slug> --budget <usd> --approved-by <member>`). Unattended: use the active run only.
3. **Run:**
   - ≤ 20 accounts (or `--unattended` with explicit domains): one `account-researcher` agent per account, up to 5 in
     parallel, each told the ICP slug and its dollar cap.
   - More: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts --skill research --icp <slug>` (one account per session).
4. **Full score** for each account that reached `researched`: run `/agentic-sales-engine:score` logic — the
   `factor-judge` agent in `full` mode with today's date and the account's files, then
   `ase score compute --icp <slug> --account <d> --mode full --judgements <file>`.
5. **Ways in:** continue with `/agentic-sales-engine:ways-in` for accounts scoring tier A/B.
6. **Report:** per account one line (score light → full, tier, top trigger, best way in or "none yet"); accounts whose
   full score dropped a tier and why; total spend vs budget. `ase ledger run end` when done (interactive only — in `--unattended` runs the batch driver owns the run).
