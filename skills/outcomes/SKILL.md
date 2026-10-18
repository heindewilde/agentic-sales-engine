---
name: outcomes
description: Record and learn from what happened with prospects. Log one outcome — a reply came in (positive, negative, out-of-office, unsubscribe), a meeting booked or held, an opportunity, a win, a loss or a disqualification — with a reason code for negative outcomes; run the weekly review that walks every account in flight in one quick multiple-choice pass; or run the win/loss analysis that checks logged outcomes against how accounts were scored, finds what's working, and proposes ICP, rubric and weight changes for the team to approve. Use whenever the user reports news about a prospect, weekly or when the status shows accounts needing an update, and periodically (e.g. monthly) or when the user asks why deals are won or lost or whether the scoring works.
argument-hint: "<domain> <what happened> [details] | (no args: weekly review) [--icp <slug>] | analyze --icp <slug> [--since YYYY-MM-DD]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# Outcomes

Outcomes are events in `outcomes/events.jsonl`; each account's state (open, no_response, engaged, meeting,
opportunity, won, lost, …) is derived from them. Sending is logged automatically when a draft is marked sent
(`ase drafts mark <file> sent --member <id>`), and silence becomes `no_response` by itself 21 days after the last
touch — so only log what *happened*. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

Forms: `outcomes <domain> <event> [details]` → **Log**; `outcomes [--icp <slug>]` → **Weekly review**;
`outcomes analyze --icp <slug> [--since <date>]` → **Win-loss**.

**Reason codes** (required for `replied_negative`, `lost`, `disqualified`): timing, no_budget, competitor, no_pain,
wrong_person, not_icp, internal_build, status_quo, other.

## Log one outcome
1. Resolve the account (domain) and ICP (ask if the account is in several). Check the current state:
   `ase outcomes state <domain>`.
2. Map what the user said to an event:
   - reply: `replied_positive` (interested), `replied_neutral` (out of office, "later", forwarded), `replied_negative`
     (not interested), `unsubscribed` (asked not to be contacted)
   - `meeting_booked`, `meeting_held`, `opportunity` (qualified deal; ask for an estimated value in EUR), `won`
     (value), `lost`, `disqualified` (we decided it's not a fit)
   - If outreach went out without a draft from the engine, log `sent` first (with `--channel`).
3. Negative outcome → infer the reason code from the user's words and confirm; keep their words in `--note`
   (business facts only).
4. `ase outcome log <domain> <event> --icp <slug> [--person <id>] [--channel <c>] [--reason <r>] [--value <eur>] --member <id> --note "…" [--date YYYY-MM-DD]`
5. **Follow-through** (also used by the weekly review):
   - `unsubscribed` → add them to the do-not-contact list (`/agentic-sales-engine:privacy block …`, i.e. `ase dnc`).
   - `meeting_booked` → offer `/agentic-sales-engine:call-prep`.
   - `replied_negative` with reason `timing` → note when to revisit in the brief's Open questions.
   - Add a dated Changelog line to the account's `brief.md`.
   - If the note reveals *why* in a way that generalizes, offer `/agentic-sales-engine:learn`.
6. Every ~10 resolved outcomes, suggest `/agentic-sales-engine:outcomes analyze`.

## Weekly review (no arguments)
Keeps the log complete with as little typing as possible.
1. `ase outcomes open [--icp <slug>]` → accounts needing an update, most urgent first, each with a prompt
   (e.g. "meeting held 18 days ago — what happened next?"). Nothing to review → say so and stop.
2. Before asking, read each account's `brief.md` Changelog — it might already say what happened. Ask the user to
   confirm instead of asking cold.
3. Ask in batches of up to 4 accounts per AskUserQuestion call (one question per account, header = short account name).
   Options by state:
   - open / no reply yet: "No reply yet" · "Positive reply" · "Not interested" · "Meeting booked"
   - engaged: "Meeting booked" · "Meeting held" · "Went quiet" · "Not interested"
   - meeting: "Opportunity opened" · "Not a fit (disqualify)" · "Lost / no go" · "Still talking"
   - opportunity: "Won" · "Lost" · "Still open"
   The user can always pick "Other" to type details. "No reply yet" / "Still …" → log nothing (the 21-day rule
   handles silence).
4. For each negative answer, collect the reason code in a second batched question — recommend the likely one first
   based on notes. For "Opportunity opened"/"Won", ask for an estimated value in EUR (optional).
5. Log each answer: `ase outcome log <domain> <event> --icp <slug> --member <reviewer> [--reason …] [--value …] [--note …]`,
   then do the follow-throughs above.
6. Accounts at 14–20 days of silence → offer a step-2 draft via `/agentic-sales-engine:draft-outreach`
   (a different angle, not a "just bumping this").
7. Summary: events logged, accounts resolved this week, current engaged rate (`ase outcomes stats --icp <slug>`), and
   whether a win-loss review is due (≥ 10 newly resolved since the last one in `icps/<slug>/win-loss/`).

## Win-loss (`analyze`)
Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/scoring.md` (calibration
thresholds and intervals), `icps/<slug>/icp.md`, `icps/<slug>/scoring.yaml`, `icps/<slug>/calibration.md`,
`learnings/*.md`, and earlier reviews in `icps/<slug>/win-loss/`.

**1. The numbers (honest about sample size).** `ase outcomes stats --icp <slug>` → engagement rate (positive reply or
better) by tier, trigger type and channel, each with a 95% interval; loss-reason counts; median score of engaged vs
non-engaged; the tier signal; recalibration readiness. Only resolved accounts count. Report rates **with their
intervals** ("tier A: 4/9 engaged, 19–73%"). Never call a difference real when intervals overlap; say what more data
would settle it. Under ~10 outcomes, treat everything as anecdote.

**2. The stories.** `ase outcomes cases --icp <slug> [--since <date>]` → each resolved account's status, engaged/won,
reason codes, notes, event history, channels, tier, factor levels, signal types and brief path. Weigh
`derived_no_response` (21-day silence) lighter than an explicit "not interested". Read the notes, and for
losses/disqualifications/wins also the brief's Risks and Ways in. Patterns need ≥ 3 accounts (one case is an anecdote):
- **False positives** (high tier, lost/disqualified/no response): which factor was high but misleading? Missing
  exclusion or knockout? (e.g. "AP centralised in a foreign HQ", "just renewed a competitor")
- **False negatives** (low tier, engaged/won): which factor undervalued them? A trait the rubric doesn't capture?
- **Triggers:** which signal types precede engagement; which don't move anything.
- **Ways in:** warm intros vs cold triggers vs channel — from drafts sent and notes.
- **Silence vs rejection:** many `no_response` with few `not_interested` points at messaging, channel or the wrong
  persona, not at the ICP. Compare channels (`by_channel`).
- **Loss reasons:** clusters of `not_icp` / `no_pain` → ICP or rubric; `wrong_person` → personas; `timing` → triggers;
  `competitor` → add a factor or exclusion for the incumbent.

**3. Proposals (never applied without approval).** Write `icps/<slug>/win-loss/<YYYY-MM-DD>.md`: the numbers, the
patterns (each citing the accounts, e.g. `import:accounts/x.com/brief.md`, and outcome notes as
`import:outcomes/outcomes.csv`), and a numbered list of typed proposals:
- **ICP change** (exclusion, persona, trigger, geography) → `/agentic-sales-engine:icp` (new version, re-approval).
- **Rubric change** (anchor wording, new factor, knockout) → `/agentic-sales-engine:icp --recalibrate`
  (archive, bump version, re-judge affected factors, back-test).
- **Weight change** → if recalibration is ready, include `ase score recalibrate --icp <slug>` output side by side with
  current weights; apply via `/agentic-sales-engine:icp --recalibrate` + `ase score recompute`.
- **Process/messaging lesson** → `learnings/preferences.md` (via `/agentic-sales-engine:learn`) or the voice profile
  (`/agentic-sales-engine:learn --voice`).
Ask which proposals to accept (AskUserQuestion, multi-select), hand each accepted one to the skill named above, and
record decisions at the bottom of the review file.
