---
name: review-outcomes
description: Weekly outcome review — walks through every account with outreach in flight, a positive reply, a meeting or an open opportunity, and collects what happened in one quick pass (multiple-choice per account), logging events with reason codes. Use weekly, when the status shows accounts needing an update, or when the user wants to update their pipeline.
argument-hint: "[--icp <slug>]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, AskUserQuestion
---

# Weekly outcome review

Keeps the outcome log complete with as little typing as possible. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase`).

1. `ase outcomes open [--icp <slug>]` → accounts needing an update, most urgent first, each with a prompt
   (e.g. "meeting held 18 days ago — what happened next?", "sent 16 days ago, no reaction — any reply?").
   Nothing to review → say so and stop.
2. Before asking, read each account's `brief.md` Changelog — it might already say what happened. Ask the user to
   confirm instead of asking cold.
3. Ask in batches of up to 4 accounts per AskUserQuestion call (one question per account, header = short account name).
   Options depend on the state:
   - open / no reply yet: "No reply yet" · "Positive reply" · "Not interested" · "Meeting booked"
   - engaged: "Meeting booked" · "Meeting held" · "Went quiet" · "Not interested"
   - meeting: "Opportunity opened" · "Not a fit (disqualify)" · "Lost / no go" · "Still talking"
   - opportunity: "Won" · "Lost" · "Still open"
   The user can always pick "Other" to type details. "No reply yet" / "Still …" → log nothing (silence becomes
   no_response automatically at 21 days).
4. For each negative answer, collect the reason code in a second batched question (timing, no_budget, competitor,
   no_pain, wrong_person, not_icp, internal_build, status_quo) — recommend the likely one first based on notes.
   For "Opportunity opened"/"Won", ask for an estimated value in EUR (optional).
5. Log each answer: `ase outcome log <domain> <event> --icp <slug> --member <reviewer> [--reason …] [--value …] [--note …]`.
   Do the follow-throughs from the log-outcome skill (unsubscribe → DNC, meeting booked → offer call prep,
   timing → revisit note in the brief).
6. Suggest follow-ups: accounts at 14–20 days of silence → offer a step-2 draft via `/agentic-sales-engine:draft-outreach`
   (a different angle, not a "just bumping this").
7. Summary: events logged, accounts resolved this week, current engaged rate (`ase outcomes stats --icp <slug>`), and
   whether a win-loss review is due (≥ 10 newly resolved since the last one in `icps/<slug>/win-loss/`).
