---
name: evals
description: Measure the quality of the engine's own work in this workspace — are quotes really in their sources, are brief statements sourced and supported, do handoffs hold, do drafts follow the outreach rules, is the scoring judge stable — and turn weak spots into concrete fixes. Use after a research batch, before trusting a new ICP's results, after changing skills or rubrics, or when the user asks how good the output is.
argument-hint: "[--llm] [--budget usd]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Glob, Grep
---

# Quality evals

CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below). Results are saved in `evals/` and compared with the
previous run of the same suite; drops of more than 0.05 are flagged as regressions.

1. **Offline suite (free, always):** `ase eval run --text`
   - `citation_faithfulness` — every scored quote appears in its raw snapshot
   - `brief_grounding` — brief statements carry a source (reported absences are exempt)
   - `snapshot_coverage` — cited URLs have a stored snapshot, so claims stay verifiable
   - `handoff_completeness` — stage contracts hold; open questions answered or marked unknown
   - `draft_rules` — length per channel, cited fact, no clichés, no numbers that aren't in the sources
   - `research_trajectory` — cheaper lookups before the deep research agent; deep agent not dominating spend
2. **LLM suite (paid, with `--llm`):** `ase eval run --suite llm --budget <usd, default 1> --sample <accounts, default 3> --text`
   — `claim_support` (do the cited sources support each statement), `judge_stability` (re-judging gives the same
   levels), `draft_quality` (specific, relevant, grounded, one clear ask, brief, on-voice). Confirm the budget first.
3. **Explain and act.** For each evaluator below ~0.9 or regressed, name the pattern behind the failures and the fix:
   - quotes not found / claims unsupported → re-verify with `/agentic-sales-engine:refresh` or correct the brief;
     if it recurs, add a lesson via `/agentic-sales-engine:learn`
   - missing snapshots → re-fetch those pages through the `fetch_pages` tool so they're stored
   - unstable judging → sharpen the factor's anchor wording via `/agentic-sales-engine:scoring-design`
   - draft issues → regenerate the draft; recurring style issues → `/agentic-sales-engine:voice-profile`
   Never "fix" a score by editing evidence to match.
