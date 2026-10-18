# The app

A local web app for daily work with the engine, so you don't need the terminal or Claude Code for it.

```bash
bun src/cli/ase.ts app --workspace ~/my-sales-workspace   # opens http://127.0.0.1:4317/
```

It has two areas, switched in the top bar:

**Work**: what you do.
- **Today:** everything waiting for you, each with one action:
  - an ICP to approve (gate 1);
  - a shortlist to approve (gate 2);
  - new full scores to review (gate 3);
  - drafts to edit and send;
  - accounts that need an outcome update;
  - facts past their expiry.

  Below that: the pipeline and this week's spend.
- **Accounts:** every company, filterable and searchable. Each account page has:
  - tabs for the brief, the score (each factor with its evidence quote and source), people, signals, drafts and outcomes;
  - actions: watch for news, log an outcome, exclude, never contact.
- **Runs:** start a step, either:
  - **here**, with your Claude subscription on this Mac; one local run at a time;
  - **in the cloud**, on Managed Agents from API credits.

  You can check the plan first and follow the log live. Cloud results come back as a pull request; review and merge it in the app, and it is pulled into your workspace. Schedules can be paused, resumed or started now.
- **Outcomes:**
  - the weekly review (one question per open account);
  - what converts by tier, trigger and channel, with 95% intervals;
  - won and lost;
  - teaching the engine a lesson.

**System**: how the engine works, read-only.
- **Process:** the steps from ICP to meetings, who does what, and what each step reads and produces.
- **Brain:** every file behind it, from your knowledge to the process.
- **Stack:** the five places the engine lives and runs, with live status: your Mac, GitHub, Anthropic, the data providers, and tracing.

## How it changes data
Every change goes through the engine's own functions, the same ones the `ase` commands use. So validation, stage contracts, the ledger and reindexing always apply. Those functions are:
- `approveIcp` / `ase icp approve`;
- `approveShortlist`;
- `reviewScores` / `ase score review`;
- `saveDraft` / `ase drafts save` (keeps the engine's original, so it learns from your edits);
- `markDraft`, `advanceStage`, `addWatch`, `addDnc`, `logEvent`.

Approvals record who you are: pick yourself under **you** in the top bar.

## Safety
- **Network:** it listens on 127.0.0.1 only, and refuses requests addressed to any other host name.
- **Writes:** every write needs a token that changes each time the app starts, sent from the app's own page.
- **Files:** only the workspace's and the engine's documents can be read; `.env` and credentials never are.
- **Keys:** the stack page shows whether each key is set, with only its last 4 characters.

## Next
An "ask the engine" box: a free-form request ("research these 3 companies", "why is X tier B?") answered by a headless session with the skills, streamed into the app.
