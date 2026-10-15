---
name: refresh
description: Keep the knowledge base fresh — re-verify facts past their TTL (headcount, titles, people's employers), mark stale signals, and re-score when something material changed. Use periodically, before outreach, or when the status shows stale facts.
argument-hint: "[--icp <slug>] [--limit <accounts>] [--unattended]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Write, Glob, Grep, WebFetch, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__find_people, mcp__plugin_agentic-sales-engine_ase__status
---

# Refresh stale knowledge

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md`. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

1. `ase ttl [--icp <slug>] --limit <n>` → stale facts grouped per entity, most advanced accounts first
   (outreach_ready → scored → researched → shortlisted → rest). Default limit 10 accounts; confirm budget for more.
2. Per entity, re-verify cheaply: `fetch_pages` on the fact's `source_url` (or the company page that would carry it).
   - Same value → update `retrieved_at` (and `raw_ref`) only.
   - Changed → update value + source; add a Changelog line to the brief; if a person left the company, set their
     `company` to the new employer only if sourced, otherwise remove the `company` link and note it in the brief.
   - Can't verify → lower `confidence` by 0.2 (floor 0.2) and keep the old retrieval date; add an Open question.
3. Signals older than their `ttl_days` → `status: stale`. For outreach_ready/scored accounts also run one
   `search_news` since the newest signal date to catch new triggers.
4. Re-score accounts where a scoring-relevant fact or signal changed (score skill), and note tier changes.
5. Report: facts re-verified / changed / unverifiable, new signals, tier changes, spend.
