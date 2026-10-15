---
name: status
description: Show the sales-engine dashboard — ICPs, funnel counts per stage, pending approval gates, stale facts, spend versus budget, and the recommended next action. Use when the user asks where things stand, what to do next, or for a pipeline/funnel overview.
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read
---

# Status

1. Run `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts doctor` and `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts ledger report --days 30`.
2. Present a compact dashboard:
   - Provider tier and what it limits.
   - Per ICP: status, scoring version, funnel counts (discovered → light_scored → shortlisted → researched → scored → outreach_ready).
   - Pending gates (these come first — they block progress).
   - Spend: today vs daily cap, last 30 days by provider, active run.
   - Knowledge health: stale facts, problems.
3. End with **one** recommended next action and the command for it. Priority: problems → pending gates →
   missing scoring model → stale facts on shortlisted accounts → next funnel stage.
