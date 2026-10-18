---
name: audit
description: Health-check the sales knowledge base and measure the quality of the engine's own work — invalid or unsourced files, broken stage contracts, stale facts, orphans, likely duplicate companies, contradictions between sources; are quotes really in their sources, are brief statements sourced and supported, do handoffs hold, do drafts follow the outreach rules, is the scoring judge stable — and turn weak spots into concrete fixes. Use when the user asks to check, clean up or audit the workspace, asks how good the research or output is, before a big research run, after a research batch, before trusting a new ICP's results, or after changing skills or rubrics.
argument-hint: "[--deep [--budget usd] [domain ...]] [--fix] [--unattended]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Grep, Glob, Agent
---

# Audit

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` first. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

- `audit` — the cheap part, plain code: steps 1–2.
- `audit --deep` — adds the semantic pass and the paid LLM suite (step 3).
- `audit --fix` — applies the safe fixes (step 5).
- `--unattended` (schedules): never pass a gate — no LLM suite, no merges, no fix that needs a go-ahead; list those
  instead. Summary ≤ 3 lines.

1. **Lint:** `ase reindex` then `ase lint`. Group the issues by kind; present counts plus the 10 most important.
2. **Offline eval suite (free, always):** `ase eval run --text`. Results are saved in `evals/` and compared with the
   previous run of the same suite; drops of more than 0.05 are flagged as regressions.
   - `citation_faithfulness` — every scored quote appears in its raw snapshot
   - `brief_grounding` — brief statements carry a source (reported absences are exempt)
   - `snapshot_coverage` — cited URLs have a stored snapshot, so claims stay verifiable
   - `handoff_completeness` — stage contracts hold; open questions answered or marked unknown
   - `draft_rules` — length per channel, cited fact, no clichés, no numbers that aren't in the sources
   - `research_trajectory` — cheaper lookups before the deep research agent; deep agent not dominating spend
3. **With `--deep`** (the expensive part):
   - **Semantic pass** on the accounts the user names, else only on accounts whose files changed in the last 7 days
     (`git log --since="7 days ago" --name-only --format= -- accounts/ | cut -d/ -f2 | sort -u`), at most 10 per run
     (most advanced stage first); say how many were left for next time. Use the `wiki-linter` agent to look for
     **contradictions** (e.g. two different headcounts with similar confidence, a person listed at two companies, a brief
     claim that disagrees with company.md facts) and **outdated narrative**.
   - **LLM suite:** `ase eval run --suite llm --budget <usd, default 1> --sample <accounts, default 3> --text` —
     `claim_support` (do the cited sources support each statement), `judge_stability` (re-judging gives the same
     levels), `draft_quality` (specific, relevant, grounded, one clear ask, brief, on-voice). Confirm the budget first.
4. **Explain and act.** For each evaluator below ~0.9 or regressed, name the pattern behind the failures and the fix:
   - quotes not found / claims unsupported → re-verify with `/agentic-sales-engine:refresh` or correct the brief;
     if it recurs, add a lesson via `/agentic-sales-engine:learn`
   - missing snapshots → re-fetch those pages through the `fetch_pages` tool so they're stored
   - unstable judging → sharpen the factor's anchor wording via `/agentic-sales-engine:icp --scoring`
   - draft issues → regenerate the draft; recurring style issues → `/agentic-sales-engine:learn --voice`
   Never "fix" a score by editing evidence to match.
5. **With `--fix`** (or the user's go-ahead), fix lint issues:
   - `invalid`: repair the frontmatter (never by inventing a source — remove the fact if no source exists).
   - `duplicate`: propose a merge (keep the canonical domain, move facts, add the other domain to `aliases`) and ask before merging.
   - `contract`: moving the account's stage back is **not** allowed; instead add an Open question for the missing artifact.
   - `stale`: suggest `/agentic-sales-engine:refresh`.
6. Log lessons that should prevent recurrence in `learnings/corrections.md`.
