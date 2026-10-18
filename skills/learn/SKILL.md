---
name: learn
description: Capture a durable lesson for the sales engine — a correction to a fact or judgement, or a preference about tone, sources, segments or how results are presented — so every future research, scoring and drafting run follows it. Also builds the team's outreach writing voice from emails they liked (--voice) and learns from how they edit the engine's drafts (--voice --from-edits), so drafts sound like them. Use when the user corrects the engine, says "remember", "always", "never", edits a draft or brief in a way that reveals a preference, talks about "our writing style" or voice, shares example emails, before the first outreach drafts, or periodically after drafts were edited or sent.
argument-hint: "<what to remember> | --voice [samples…] | --voice --from-edits"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# Learn

Forms:
- `learn <lesson>` — capture a correction or preference.
- `learn --voice [samples…]` — build or update the voice profile from emails the team liked.
- `learn --voice --from-edits` — learn from how the team edited the engine's drafts.

## Capture a lesson (`<lesson>`)

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
   `/agentic-sales-engine:icp` instead of only noting it.

## Voice (`--voice`)

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/methodology/outreach.md` (how drafts use the voice).
The profile lives at `company/voice/profile.md`; samples in `company/voice/samples/`.

### Build (no profile yet, or new samples)
1. Ask for 3–5 outreach emails or LinkedIn messages the team wrote and liked (pasted, or files dropped in
   `company/voice/samples/`). Save pasted ones as `samples/<n>.md` with personal data of recipients removed
   (keep only the text and the team member who wrote it).
2. Derive the profile — be concrete, quote the samples (`[^n]: import:company/voice/samples/<file>`):
   - **Tone & register** (formal/informal, you/u/Sie, humour, confidence), per language if they write in several.
   - **Shape:** typical length (words), paragraphs, subject line style, greeting, sign-off, signature.
   - **Moves they use:** how they open, how they connect to the prospect, how they ask (CTA style).
   - **Do / don't lists:** phrases they use; words and patterns to avoid (e.g. "I hope this finds you well", "synergy").
   - **Example lines** worth reusing as patterns (not templates to copy verbatim).
3. Show the profile; adjust with the user.

### Learn from edits (`--from-edits`)
1. `ase drafts edits` → pairs of engine original vs the version the human edited or sent.
2. For each pair, name what changed and why it likely changed (shorter? less formal? removed a claim? different CTA?).
   Look for patterns across pairs — one edit is an anecdote, three are a rule.
3. Update `company/voice/profile.md` (add/adjust do/don't rules, with "learned from N edits, <date>"), and put
   non-voice lessons (e.g. "don't mention funding rounds", "always reference a case study") in
   `learnings/preferences.md` as in *Capture a lesson*.
4. `ase drafts learned <files…>` so the same edits aren't counted twice. Report what changed in the profile.
