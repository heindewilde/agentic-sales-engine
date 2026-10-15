---
name: voice-profile
description: Build or update the team's outreach writing voice from emails they liked, and learn from how they edit the engine's drafts — so future drafts sound like them. Use before the first outreach drafts, when the user shares example emails, or periodically after drafts were edited or sent (--learn).
argument-hint: "[--learn]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# Voice profile

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` and `${CLAUDE_PLUGIN_ROOT}/methodology/outreach.md`.
The profile lives at `company/voice/profile.md`; samples in `company/voice/samples/`.

## Build (no profile yet, or new samples)
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

## Learn from edits (`--learn`)
1. `ase drafts edits` → pairs of engine original vs the version the human edited or sent.
2. For each pair, name what changed and why it likely changed (shorter? less formal? removed a claim? different CTA?).
   Look for patterns across pairs — one edit is an anecdote, three are a rule.
3. Update `company/voice/profile.md` (add/adjust do/don't rules, with "learned from N edits, <date>"), and put
   non-voice lessons (e.g. "don't mention funding rounds", "always reference a case study") in
   `learnings/preferences.md`.
4. `ase drafts learned <files…>` so the same edits aren't counted twice. Report what changed in the profile.
