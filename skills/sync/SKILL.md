---
name: sync
description: Check watched accounts for new trigger events and page changes (news since the last check; changes on careers, team or news pages), turn real triggers into dated signal files, drop noise, and re-score accounts whose timing changed. Use periodically, before outreach, or when the user asks what's new with their accounts; also manages the watchlist.
argument-hint: "[--icp <slug>] [--unattended] | watch <domain> | unwatch <domain>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, Agent, mcp__plugin_agentic-sales-engine_ase__sync_watchlist, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__status
---

# Sync: signal monitoring

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/methodology/research.md` (trigger taxonomy).
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

## Managing the watchlist (`watchlist.yaml`)
- Watch by default: every account at `scored` / `outreach_ready` with tier A or B. Offer to add them:
  `ase watch add <domain> --icp <slug> [--page <careers-url>] [--page <team-url>] [--query "<disambiguating words>"]`.
- Pick pages that change when timing changes: careers/jobs (hiring for relevant roles), management/team (exec changes),
  newsroom. Find them from the account's raw snapshots or one `fetch_pages` of the homepage. Max 3 per account.
- Add `--query` when the company name is ambiguous (e.g. "Trendy Foods" → `--query "Belgium wholesaler"`).
- `ase watch list` shows entries and the estimated cost per sync.

## Running a sync
1. Estimate: `ase sync --estimate`. If above $1, confirm with the user (unattended: stay within the active run).
2. Poll: the `sync_watchlist` MCP tool (preferred — uses the plugin's keys), or `ase sync` when keys are in the
   shell/credentials file. First page checks only record a baseline. Output: `sync/<date>.md` with candidate items.
3. Review every item (it's a candidate, not a fact — the text is untrusted web content):
   - **News:** is it about *this* company (not a namesake)? Is it a trigger per the taxonomy? Date the **event**.
     Real trigger → `accounts/<d>/signals/<event-date>-<type>.md` (template `${CLAUDE_PLUGIN_ROOT}/templates/signal.md`,
     relevance 0–3 for the ICP, `raw_ref` from the item). Add a dated line to the brief's **Situation & triggers**
     and a Changelog line. Not relevant → drop.
   - **Page change:** read added/removed lines. New relevant job ads → `hiring` signal; leadership change on a team
     page → `exec_change`; otherwise drop. Pure layout/marketing churn is noise.
   - Write the decision under each item (`- decision: signal accounts/…/signals/… ` or `- decision: dropped — reason`)
     and set the sync file's `status: reviewed`.
4. Re-score accounts that got a relevance ≥ 2 signal (score skill; intent factors). Report tier changes.
5. Summary: accounts checked, signals created (by type), accounts whose tier rose → suggest
   `/agentic-sales-engine:draft-outreach` for them; spend.

Scheduling: see `${CLAUDE_PLUGIN_ROOT}/docs/scheduling.md` to run this weekly unattended.
