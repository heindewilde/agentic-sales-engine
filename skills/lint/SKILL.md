---
name: lint
description: Health-check the sales knowledge base — invalid or unsourced files, broken stage contracts, stale facts, orphans, likely duplicate companies, and contradictions between sources. Use when the user asks to check, clean up or audit the workspace, or before a big research run.
argument-hint: "[--fix]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Grep, Glob, Agent
---

# Lint the knowledge base

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` first.

1. `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts reindex` then `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts lint`.
2. Group the issues by kind and present counts plus the 10 most important.
3. Semantic pass (only when there are fewer than ~200 accounts, or for the accounts the user names): use the
   `wiki-linter` agent to look for **contradictions** (e.g. two different headcounts with similar confidence,
   a person listed at two companies, a brief claim that disagrees with company.md facts) and **outdated narrative**.
4. With `--fix` (or the user's go-ahead), fix mechanical issues:
   - `invalid`: repair the frontmatter (never by inventing a source — remove the fact if no source exists).
   - `duplicate`: propose a merge (keep the canonical domain, move facts, add the other domain to `aliases`) and ask before merging.
   - `contract`: move the account's stage back is **not** allowed; instead add an Open question for the missing artifact.
   - `stale`: suggest `/agentic-sales-engine:refresh`.
5. Log lessons that should prevent recurrence in `learnings/corrections.md`.
