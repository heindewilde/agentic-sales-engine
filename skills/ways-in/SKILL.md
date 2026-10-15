---
name: ways-in
description: Find and rank concrete ways into an account — warm intros through the team's LinkedIn connections, dated trigger events to reference, and shared context — and write them into the account brief. Use after research/scoring, or when the user asks how to approach or get introduced to a company.
argument-hint: "--icp <slug> [--unattended] [domain ...]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Glob, Grep, mcp__plugin_agentic-sales-engine_ase__find_people, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__fetch_pages
---

# Ways in

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/methodology/ways-in.md`.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

Accounts: domains in `$ARGUMENTS`, else stage `scored` with tier A or B (`ase score rank --icp <slug> --stage scored`).
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
   Update `sections_updated."Ways in"`, add a Changelog line.
4. If the warm-path picture changed the access factors (`warm_path`, `persona_reachable`…), rescore those via the
   score skill. Then **always** advance: `ase stage advance <domain> --icp <slug> --to outreach_ready` (or
   `"stage": "outreach_ready"` in the `ase apply` file) as soon as the Ways in section has at least one usable way —
   cold trigger-based ways count. Hold an account back only when there is no usable way at all, or the only way is a
   warm intro the team member must confirm first; then add an open question (owner `ways_in`) saying what's needed and
   list it as "held" in the final reply.

Finish with a table: account, tier, best way in, owner (team member to act). Nothing is sent to anyone.
