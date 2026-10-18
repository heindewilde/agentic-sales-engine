---
name: ways-in
description: Find and rank concrete ways into an account — warm intros through the team's LinkedIn connections, dated trigger events to reference, and shared context — and write them into the account brief. Also imports a team member's LinkedIn Connections.csv export for warm-intro matching. Use after research/scoring, when the user asks how to approach or get introduced to a company, or wants to import their LinkedIn connections.
argument-hint: "--icp <slug> [--unattended] [domain ...] | --connections <member> <Connections.csv> [--icp <slug> domain ...]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Glob, Grep, mcp__plugin_agentic-sales-engine_ase__find_people, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__fetch_pages
---

# Ways in

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/methodology/ways-in.md`.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

**Import connections (`--connections <member> <file>`).**
- No export yet? LinkedIn → Settings & Privacy → Data privacy → Get a copy of your data → **Connections** → request;
  the email arrives within ~10 minutes. Use `Connections.csv` from the zip.
- `ase import connections <file> --member <member-id>` (the member must be in `ase.config.yaml`).
- Explain the privacy model: the full export stays on this machine (`team/<member>/connections.csv`, gitignored); only
  connections at companies tracked in this workspace are written to the committed `warm-matches.yaml`. Email
  addresses from the export are never stored.
- Matches refresh automatically after seed imports (`discover --seeds`); after discovery runs, `ase connections match`.
- No ICP or accounts given → report the matches and stop. Otherwise continue below.

Accounts: domains in `$ARGUMENTS`, else stage `scored` with tier A or B (`ase score rank --icp <slug> --stage scored`)
whose scores the user reviewed (GATE 3). Interactive and not reviewed yet: show the ranking and ask first.
Run `ase connections match` once first so new accounts get their warm matches.

Per account:
1. `ase ways-in <domain> --icp <slug>` → warm paths (member, person, position, persona, strength 3 = direct to a
   persona, 2 = can introduce), recent signals (dated, relevance), people and personas still without a named person.
2. Read the brief (Situation & triggers, People map) for context. Optionally one cheap lookup if a persona has no named
   person and there is a warm path to the company (`find_people`), or the person's own recent public talk/article.
3. Write the brief **Ways in** section: 1–5 ranked ways, each with
   - **Path** — "Sam (team) ↔ Tom Jansen, Head of AP (direct, connected 2024)" or "Trigger: new CFO since 2026-03[^n]",
   - **Why it works** — one sentence tied to the ICP pains,
   - **Suggested opener** — one sentence (a warm intro ask to the member, or a trigger → insight line). Never invent shared history.
   Mention when the team member should be asked first how well they really know the person.
4. Write all accounts in **one** `ase apply` file (`${CLAUDE_PLUGIN_ROOT}/references/output-format.md`): per account the
   `Ways in` section, its sources and a changelog. Writing Ways in makes the account `outreach_ready` (cold
   trigger-based ways count). To hold one back (no usable way, or a warm intro the team member must confirm first), add
   an open question `- [ ] … (owner: ways_in)` saying what's needed, and list it as "held" in the final reply. If the
   warm-path picture changed the access factors (`warm_path`, `persona_reachable`…), include their new `judgements`.

Finish with a table: account, tier, best way in, owner (team member to act). Nothing is sent to anyone.
