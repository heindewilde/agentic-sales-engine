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
1. `ase context <domains…> --icp <slug> --mode full` → ICP (personas, triggers), all factors with anchors and
   evidence hints, auto factors, rules digest, learnings, each account's facts, snapshot, open questions, signals and
   team warm matches.
2. Research cheapest-first, batching calls across accounts where possible:
   - **one** `fetch_pages` for About/Team/Careers/News pages, with `focus` = the open questions + factor evidence hints,
     `max_chars` 3000 (job ads reveal systems and pains; leadership pages reveal people). Include the pages that settle
     factors whose level 0 is an absence (e.g. the careers page for hiring factors) and, when a factor needs prices, one
     product or collection page: then "checked, not there" can be judged as level 0 instead of unknown;
   - `search_news` for each company since 18 months ago (local language too if not English) → dated trigger events;
   - `find_people` once per ICP persona (current company must be the account; business data only; never LinkedIn scraping);
   - `extract` or `research` (effort low) **only** for important questions the above didn't answer.
3. Write **one** JSON file `.ase/tmp/research-<first-domain>.json` (same shape as `ase apply`; see enrich-light) with,
   per account: `facts`; `sections` for "Business & offering", "Situation & triggers" (dated), "Technographics",
   "People map", "Risks & fit concerns" (footnoted, concise); `sources`; `open_questions` (every question either
   `- [x] … → answer[^id]` or `- [ ] … (unknown after research; owner: <stage>)`); `people`; `signals` (event date,
   relevance 0–3); `judgements` for **all** factors in `factors` (`"mode": "full"`); `"stage": "researched"`; `changelog`.
   Quote evidence exactly from the pages/snapshots you read and pass their `raw_ref`. Every web source in `sources` is
   `{label, url, date, quote, raw_ref}`: the quote holds the exact words its statements rest on, and every detail in a
   statement (a number, a country, a role, a date) must be in one of its footnotes' quotes. `ase apply` rejects a quote
   that isn't on the saved page, and a number or date in a statement that none of its quotes contains; then fix the quote, cite the page that does say it, or drop the detail.
4. `ase apply <file>` → each account ends at `scored` (or lists errors to fix and re-apply).
5. Interactive: one line per account (light → full score, tier, top trigger, best way in or "none yet") and spend.
   Unattended: ≤ 3 lines. Then GATE 3: the user reviews the scores; `/agentic-sales-engine:ways-in` follows for the
   tier A/B accounts they confirm.
