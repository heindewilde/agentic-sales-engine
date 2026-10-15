---
name: log-outcome
description: Record what happened with a prospect — a reply (positive, negative, out-of-office, unsubscribe), a meeting booked or held, an opportunity, a win, a loss or a disqualification — with a reason code for negative outcomes, so the engine learns which accounts, triggers and channels actually work. Use whenever the user reports news about a prospect.
argument-hint: "<domain> <what happened> [details]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, AskUserQuestion
---

# Log an outcome

Outcomes are events in `outcomes/events.jsonl`; each account's state (open, no_response, engaged, meeting,
opportunity, won, lost, …) is derived from them. Sending is logged automatically when a draft is marked sent
(`ase drafts mark <file> sent --member <id>`), and silence becomes `no_response` by itself 21 days after the last
touch — so only log what *happened*. CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

1. Resolve the account (domain) and ICP (ask if the account is in several). Check the current state:
   `ase outcomes state <domain>`.
2. Map what the user said to an event:
   - reply: `replied_positive` (interested), `replied_neutral` (out of office, "later", forwarded), `replied_negative`
     (not interested), `unsubscribed` (asked not to be contacted)
   - `meeting_booked`, `meeting_held`, `opportunity` (qualified deal; ask for an estimated value in EUR), `won`
     (value), `lost`, `disqualified` (we decided it's not a fit)
   - If outreach went out without a draft from the engine, log `sent` first (with `--channel`).
3. **Negative outcomes need a reason code** (`replied_negative`, `lost`, `disqualified`): timing, no_budget,
   competitor, no_pain, wrong_person, not_icp, internal_build, status_quo, other. Infer it from the user's words and
   confirm; keep their words in `--note` (business facts only).
4. `ase outcome log <domain> <event> --icp <slug> [--person <id>] [--channel <c>] [--reason <r>] [--value <eur>] --member <id> --note "…" [--date YYYY-MM-DD]`
5. Follow-through:
   - `unsubscribed` → add them to the do-not-contact list (`/agentic-sales-engine:dnc`).
   - `meeting_booked` → offer `/agentic-sales-engine:call-prep`.
   - `replied_negative` with reason `timing` → note when to revisit in the brief's Open questions.
   - Add a dated Changelog line to the account's `brief.md`.
   - If the note reveals *why* in a way that generalizes, offer `/agentic-sales-engine:learn`.
6. Every ~10 resolved outcomes, suggest `/agentic-sales-engine:win-loss`.
