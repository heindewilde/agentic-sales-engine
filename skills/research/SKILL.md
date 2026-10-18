---
name: research
description: Deep research on approved (shortlisted) accounts — triggers, buying committee, systems, fit risks — followed by the full score. Use after the shortlist is approved, or when the user asks to research specific accounts in depth.
argument-hint: "--icp <slug> [--unattended] [domain ...]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts *), Read, Write, Glob, Grep, Agent, WebSearch, WebFetch, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__extract, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__find_people, mcp__plugin_agentic-sales-engine_ase__research, mcp__plugin_agentic-sales-engine_ase__estimate, mcp__plugin_agentic-sales-engine_ase__status
---

# Deep research (deep funnel)

CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

1. **Accounts:** domains in `$ARGUMENTS`, else `ase accounts --icp <slug> --stage shortlisted`. Only accounts that passed
   GATE 2 (stage `shortlisted` with `approved_by`).
2. **Budget:** there should be an active run from the shortlist approval (`ase ledger report`). Interactive and none
   active → start one: with `claude_billing: api` propose `budgets.deep_research_per_account_usd` × accounts and wait for
   agreement; on a subscription use `budgets.research_providers_per_account_usd` × accounts without asking.
3. **How:** more than ~4 accounts and interactive → `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts --skill research --icp <slug>`
   (2 accounts per session). Otherwise do the fast path below yourself — **no sub-agents** (each one re-reads everything).

## Fast path (1–2 accounts)
1. `ase context <domains…> --icp <slug> --mode full`: ICP, factors with evidence hints, rules, learnings and each
   account's current files in one JSON.
2. Research each account as `${CLAUDE_PLUGIN_ROOT}/methodology/research.md` describes, batching calls across accounts
   where you can (one `fetch_pages` per account, `focus` + `max_chars` 1500).
3. Write **one** file `.ase/tmp/research-<first-domain>.json` as `${CLAUDE_PLUGIN_ROOT}/references/output-format.md`
   shows: per account facts, the research sections, sources, open questions, people, signals, judgements for all
   factors (`"mode": "full"`, per `${CLAUDE_PLUGIN_ROOT}/references/judging.md`), `"stage": "researched"`, changelog.
4. `ase apply <file>`: each account ends at `scored`, or it lists errors; fix only those and apply again.
5. Interactive: one line per account (light → full score, tier, top trigger, best way in or "none yet") and spend.
   Unattended: ≤ 3 lines. Then GATE 3: the user reviews the scores; `/agentic-sales-engine:ways-in` follows for the
   tier A/B accounts they confirm.
