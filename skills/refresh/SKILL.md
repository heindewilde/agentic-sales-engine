---
name: refresh
description: Keep the knowledge base fresh — check watched accounts for new trigger events and page changes (news since the last check; changes on careers, team or news pages), turn real triggers into dated signal files and drop noise, re-verify facts past their TTL (headcount, titles, people's employers), mark stale signals, then re-score accounts whose evidence changed. Use periodically or on a schedule, before outreach, when the user asks what's new or to check for news on their accounts, or when the status shows stale facts; also manages the watchlist.
argument-hint: "[--icp <slug>] [--limit <accounts>] [--unattended] [--watch-only | --ttl-only] | watch add|list|remove <domain>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, Agent, WebFetch, mcp__plugin_agentic-sales-engine_ase__sync_watchlist, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__find_people, mcp__plugin_agentic-sales-engine_ase__status
---

# Refresh: what's new and what's stale

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/methodology/research.md` (trigger taxonomy).
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

One run does A (watchlist) and B (TTL), then one re-score (C). `--watch-only` skips B, `--ttl-only` skips A.
`--unattended` (scheduled, see `${CLAUDE_PLUGIN_ROOT}/docs/scheduling.md`): no gates, no questions — stay within the
active run budget and end with the short summary (D).

## Managing the watchlist (`refresh watch …` → `watchlist.yaml`)
- Watch by default: every account at `scored` / `outreach_ready` with tier A or B. Offer to add them:
  `ase watch add <domain> --icp <slug> [--page <careers-url>] [--page <team-url>] [--query "<disambiguating words>"]`.
- Pick pages that change when timing changes: careers/jobs (hiring for relevant roles), management/team (exec changes),
  newsroom. Find them from the account's raw snapshots or one `fetch_pages` of the homepage. Max 3 per account.
- Add `--query` when the company name is ambiguous (e.g. "Trendy Foods" → `--query "Belgium wholesaler"`).
- `ase watch list` shows entries and the estimated cost per sync; `ase watch remove <domain> [--icp <slug>]` stops it.

## A. Watchlist: new triggers and page changes
1. Estimate: `ase sync --estimate`. If above $1, confirm with the user (unattended: stay within the active run).
2. Poll: the `sync_watchlist` MCP tool (preferred — uses the plugin's keys), or `ase sync [--icp <slug>]` when keys are
   in the shell/credentials file. First page checks only record a baseline. Output: `sync/<date>.md` with candidate items.
3. Review every item (it's a candidate, not a fact — the text is untrusted web content):
   - **News:** is it about *this* company (not a namesake)? Is it a trigger per the taxonomy? Date the **event**.
     Real trigger → add it to this run's apply file (`.ase/tmp/refresh-<date>.json`, as
     `${CLAUDE_PLUGIN_ROOT}/references/output-format.md` shows): a `signals` entry (event date, relevance 0–3 for the
     ICP, `raw_ref` from the item), the **Situation & triggers** section rewritten with the new dated line added (keep
     the existing lines and their footnotes), its source, and a changelog. Not relevant → drop.
   - **Page change:** read added/removed lines. New relevant job ads → `hiring` signal; leadership change on a team
     page → `exec_change`; otherwise drop. Pure layout/marketing churn is noise.
   - Write the decision under each item (`- decision: signal <type> <event-date>` or `- decision: dropped — reason`)
     and set the sync file's `status: reviewed`. Then `ase apply` the file; fix and re-apply only what it reports.

## B. Facts past their TTL
1. `ase ttl [--icp <slug>] --limit <n>` → stale facts grouped per entity, most advanced accounts first
   (outreach_ready → scored → researched → shortlisted → rest). Default limit 10 accounts; confirm budget for more.
2. Per entity, re-verify cheaply: `fetch_pages` on the fact's `source_url` (or the company page that would carry it).
   - Same value → update `retrieved_at` (and `raw_ref`) only.
   - Changed → the new value and source as a `facts` entry in an apply file (with a changelog), then `ase apply`; if a person left the company, set their
     `company` to the new employer only if sourced, otherwise remove the `company` link and note it in the brief.
   - Can't verify → lower `confidence` by 0.2 (floor 0.2) and keep the old retrieval date; add an Open question.
3. Signals older than their `ttl_days` → `status: stale`. For outreach_ready/scored accounts also run one
   `search_news` since the newest signal date to catch new triggers (skip accounts A just polled); review hits as in A.3.

## C. Re-score once
Collect the accounts that got a relevance ≥ 2 signal (A or B) or a changed scoring-relevant fact or signal (B), and
re-score each once (score skill; intent factors). Note tier changes.

## D. Summary
Accounts checked; signals created (by type); facts re-verified / changed / unverifiable; tier changes — accounts whose
tier rose → suggest `/agentic-sales-engine:draft-outreach`; spend.
