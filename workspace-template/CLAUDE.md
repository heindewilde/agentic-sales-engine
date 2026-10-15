# Sales engine workspace

This repository is a **knowledge base for B2B prospecting**, driven by the `agentic-sales-engine` Claude Code plugin.
Markdown files are the source of truth; `.ase/ase.db` is a derived index (never edit it, run `reindex`).

## Where things live
- `ase.config.yaml` — team, budgets, privacy mode, models, providers, TTLs.
- `company/` — who we are (profile.md) and our sales materials.
- `icps/<slug>/` — each ideal customer profile (`icp.md`) and its scoring model (`scoring.yaml`, versioned).
- `accounts/<domain>/` — one folder per company: `company.md` (facts), `brief.md` (research handoff), `scores/`, `signals/`.
- `people/<id>.md` — one file per person (business-relevant data only).
- `lists/<icp>/<run>/` — discovery runs and shortlists.
- `team/<member>/warm-matches.yaml` — who on the team knows whom (raw LinkedIn exports stay local, gitignored).
- `raw/` — immutable source snapshots that facts cite.
- `learnings/` — preferences and corrections every skill reads.
- `dnc.yaml` — do-not-contact list. `ledger/costs.jsonl` — provider spend.

## Rules
- Every fact carries `source_url`, `retrieved_at` and `confidence`. A plugin hook rejects writes without them.
- Never store personal data that isn't business-relevant. Never scrape LinkedIn.
- Nothing is ever sent to a prospect from here — the engine drafts, people send.

Start with `/agentic-sales-engine:status`.
