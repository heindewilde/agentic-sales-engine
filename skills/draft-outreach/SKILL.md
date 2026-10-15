---
name: draft-outreach
description: Draft personalized first-touch outreach for accounts with a way in — email, LinkedIn connection note and DM, or a warm-intro request for a teammate to forward — grounded in the account brief and written in the team's voice. Drafts only; nothing is ever sent. Use for outreach-ready accounts or when the user asks to write to a prospect.
argument-hint: "--icp <slug> [domain ...] [--channel email|linkedin|intro] [--person <id>]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, mcp__plugin_agentic-sales-engine_ase__search_news
---

# Draft outreach (never sends)

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/outreach.md`,
`company/voice/profile.md` (if missing, suggest `/agentic-sales-engine:voice-profile` first — or draft with the
methodology defaults and say so), `company/profile.md` (proof points), `learnings/*.md`, the ICP (persona pains).
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

**Accounts:** domains given, else `ase accounts --icp <slug> --stage outreach_ready`. Skip accounts already holding an
unsent draft for the same person and channel (`ase drafts list --account <d>`).

Per account:
1. Read `brief.md` (Ways in, Situation & triggers, People map, Risks), the score file, signals, the target person's
   file. Check the recipient isn't on the do-not-contact list (`ase dnc check <linkedin-url>`).
2. **Freshness:** if the trigger you'll reference is older than ~90 days, run one `search_news` since that date; don't
   congratulate someone on news that's been overtaken.
3. **Pick the channel from the top way in:**
   - Warm path → `intro_request`: a short note to the team member (why this account, why now) plus a 2–3 sentence
     forwardable blurb. Ask them first how well they know the person.
   - Trigger / cold → `email` (step 1, ≤ 100 words) and/or `linkedin_connect` (≤ 300 characters, no pitch) +
     `linkedin_dm` (after acceptance).
4. **Write** (trigger → insight → ask): one true, specific, dated observation; one insight connecting it to a pain the
   persona has (from the ICP); a low-friction interest-based ask. One idea per message. Use the voice profile.
   Every claim about the prospect gets a footnote to its source (brief/signal/raw URL). Never invent familiarity,
   numbers, or mutual connections.
5. Save as `accounts/<d>/drafts/<YYYY-MM-DD>-<person-id>-<channel>.md` (template
   `${CLAUDE_PLUGIN_ROOT}/templates/draft.md`; `based_on` lists the files you relied on). The hook rejects drafts
   without a cited fact or to DNC recipients. Then freeze the baseline: `ase drafts snapshot <file>`.
6. Optional follow-ups (step 2–3, different angle each — a proof point, a question) only if the user asks.

Finish with a table: account, person, channel, way in, file. Remind the user: edit freely, then
`ase drafts mark <file> sent --member <id>` once sent (this starts outcome tracking; silence counts as no response
after 21 days) or `edited` — the engine learns from their changes via `voice-profile --learn`.
If the user explicitly asks for Gmail drafts and a Gmail tool is available, create drafts there too — never send.
