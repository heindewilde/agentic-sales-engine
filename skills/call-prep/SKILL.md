---
name: call-prep
description: Prepare a one-page brief for an upcoming sales call — who they are and why now, who's in the room, hypotheses to test, tailored discovery questions (SPIN), qualification gaps (MEDDICC), likely objections with evidence-based answers, and the desired outcome. Use when the user has a meeting with a prospect or asks to prepare for a call.
argument-hint: "<domain> [--date YYYY-MM-DD] [--attendees 'Name, Name'] [--objective '...']"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, Agent, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__find_people, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__status
---

# Call prep

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/call-prep.md`,
`company/profile.md` and `company/materials/` (case studies, proof points), `learnings/*.md`.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

1. **Context:** the account's `company.md`, `brief.md`, `scores/<icp>.md`, `signals/`, `notes.md`, drafts sent
   (`ase drafts list --account <d>`), outcomes (`outcomes/outcomes.csv`), and `people/` files for the attendees.
   Unknown account? Run discover/enrich-light/research for it first (ask; it costs money).
2. **Freshen (cheap):** `search_news` since the newest signal date (or 60 days). Attendees without a people file →
   `find_people` (business data only, create their people files). New triggers → signal files.
3. **Write** `accounts/<d>/callprep/<meeting-date>.md` (template `${CLAUDE_PLUGIN_ROOT}/templates/callprep.md`), max
   ~1 page, every claim footnoted:
   1. **Snapshot & why now** — 3 lines: what they do, the trigger(s), why we fit (highest fit factors).
   2. **Who's in the room** — per attendee: role in deal (persona), likely priorities, how we're connected, what they
      saw from us (drafts sent).
   3. **Hypotheses to test** — from unknown / low-confidence factors and open questions in the brief.
   4. **Discovery questions (SPIN)** — 2 Situation (only what research couldn't answer), 3 Problem, 2 Implication,
      2 Need-payoff; tied to the ICP pains and their situation. No questions whose answer is in our files.
   5. **Qualification gaps (MEDDICC)** — Metrics, Economic buyer, Decision criteria, Decision process, Identify pain,
      Champion, Competition: what we know (cited) / what to learn on this call.
   6. **Likely objections** — 3–4, each with a response grounded in our materials (cite the case study) or a question
      to turn it around. Include the competitor/incumbent if known.
   7. **Desired outcome & next step** — what a good call ends with; a fallback.
4. Add a Changelog line to the brief, and show the prep. After the call, suggest `/agentic-sales-engine:outcomes <domain> <event>`
   and adding notes to `accounts/<d>/notes.md`.
