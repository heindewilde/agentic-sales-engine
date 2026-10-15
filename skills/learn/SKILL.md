---
name: learn
description: Capture a durable lesson for the sales engine — a correction to a fact or judgement, or a preference about tone, sources, segments or how results are presented — so every future research, scoring and drafting run follows it. Use when the user corrects the engine, says "remember", "always", "never", or edits a draft or brief in a way that reveals a preference.
argument-hint: "<what to remember>"
allowed-tools: Read, Edit, Write, Grep
---

# Capture a learning

Learnings live in two files that every skill reads before starting:
- `learnings/corrections.md` — something was wrong (a fact, a classification, a score rationale) and why.
- `learnings/preferences.md` — how the team wants things done (sources to trust/avoid, segments to skip, tone, format).

Steps:
1. Decide which file it belongs to. If it corrects a specific fact, **also fix the fact** at its source file
   (with `source_url: user:<member>` and today's date) so the knowledge base and the lesson agree.
2. Generalize one level: "Acme is a reseller" → also note *how to tell* ("check the About page; directories mislabel resellers").
   Don't over-generalize from one example — say what it applies to.
3. Append one bullet: `- <YYYY-MM-DD> (<member>) [<scope: icp/account/stage>]: <lesson> — <why>`.
   Check for an existing bullet that says the same and update it instead of duplicating; remove bullets the new one contradicts.
4. If the lesson changes how a factor should be judged, suggest a scoring.yaml edit (new anchor wording) via
   `/agentic-sales-engine:scoring-design` instead of only noting it.
