---
name: discover
description: Find companies that match an approved ICP — runs the ICP's discovery queries per sub-segment and country through the company index, deduplicates against the workspace and the do-not-contact list, and adds new candidates as accounts. Use when the user wants to find prospects, build a target list, or expand coverage for an ICP.
argument-hint: "--icp <slug> [--target <n accounts>] [--budget <usd>]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Glob, Grep, WebSearch, WebFetch, mcp__plugin_agentic-sales-engine_ase__discover_companies, mcp__plugin_agentic-sales-engine_ase__estimate, mcp__plugin_agentic-sales-engine_ase__status
---

# Discover candidates (wide funnel, step 1)

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/research.md`,
`icps/<slug>/icp.md` (must be `approved` — otherwise stop and point to icp-build), learnings files.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

1. **Plan.** Target size (default 300 candidates, or `--target`). Take the ICP's `discovery_queries`; if there are fewer
   than ~6, derive more by splitting on sub-industry × country × size band. Estimate cost with the `estimate` tool
   (≈ $0.04 per 25 results). Start a run: `ase ledger run start --stage discover --icp <slug> --budget <usd>`
   (default: `budgets.per_run_usd`). Run id for grouping: `<YYYY-MM-DD>-discover`.
2. **Query loop.** For each query: `discover_companies` with `{query, num_results: 25, country, icp: <slug>, run_id}`.
   With `icp` set, results are saved as accounts directly and you get a compact summary back
   (`created`, `already_known`, `new_share`).
   - Rephrase or narrow queries whose results are off-target (check a few created names against the ICP).
   - Stop a query family when `new_share` < 0.2 (saturated); stop overall at the target or the run budget.
   - Exclusions from the ICP (e.g. public sector) that slip through are fine for now — light scoring knocks them out.
3. **Tier T0 (no provider):** use WebSearch for directory/association member lists and registry pages, collect
   name + website into a CSV in your scratchpad, then `ase import seeds <csv> --icp <slug> --run <run_id>`.
4. **Wrap up.** `ase connections match` (new accounts may have warm paths), `ase ledger run end`, then report:
   queries run, accounts created, saturation, spend, and a sample of 10 created names for a sanity check.
   Next: `/agentic-sales-engine:enrich-light --icp <slug>`.
