# agentic-sales-engine

Run B2B client prospecting, scoring, outreach and call prep on autopilot — inside Claude Code.

A Claude Code plugin that takes a team from **"who should we sell to?"** to **"here's who, why, why now, and how to get in"**:

1. **Define your ICP** — from your website and materials, lookalikes of your best customers, and a short gap interview.
2. **Design a scoring model** — Fit × Intent × Access, anchored rubrics, back-tested against customers you already know.
3. **Discover** hundreds of candidate companies in any geography (Exa + your own seed lists), deduplicated.
4. **Score wide, then research deep** — cheap light scoring for everyone, deep research only for the shortlist you approve.
5. **Find ways in** — warm intros from your team's LinkedIn connection exports, dated trigger events, shared context.
6. **Prep outreach and calls** *(next milestones)* — drafts in your voice, one-page call briefs. Nothing is ever sent for you.

The value is in the handoffs: every stage reads what the previous one learned (an account **brief** with open questions)
and leaves it better. Everything lives in a git-tracked **workspace** of markdown files that your team can read, edit and review.

> **Status:** early development — M0–M4 done: knowledge harness, provider gateway, ICP builder, scoring design & calibration.
> Next: wide funnel (discover → light score → shortlist), then deep research and ways in. See [docs/architecture.md](docs/architecture.md).

## Install

Requires [Claude Code](https://claude.com/claude-code) and [Bun](https://bun.sh) ≥ 1.3.

```
/plugin install agentic-sales-engine --marketplace heindewilde/agentic-sales-engine
```

Then, in an empty folder: `/agentic-sales-engine:setup`. This creates your workspace (its own git repo) and
pre-configures the plugin for teammates who clone it.

Provider keys (optional, entered via `/plugin` → configure, stored in your OS keychain):
- **Exa** — company & people discovery, news, deep research. Free tier: $10/month credit.
- **Firecrawl** — structured extraction from company websites, page monitoring. Free tier: 1,000 credits/month; self-hostable.

Without keys the engine runs on Claude Code's built-in web search and your CSV imports (slower, shallower).
For CLI/batch runs outside Claude Code, put `EXA_API_KEY` / `FIRECRAWL_API_KEY` in a gitignored `.env` in the workspace.

## Principles

- **Evidence or nothing.** Every fact carries a source URL, date and confidence; a hook rejects unsourced writes.
  Unknowns stay unknown — scores show coverage and upside instead of guessing.
- **Humans at the gates.** You approve the ICP and the shortlist (with a cost estimate) before money is spent on deep research.
- **Privacy by default.** Business-relevant data only, do-not-contact list everywhere, one-command GDPR erasure,
  no LinkedIn scraping. Raw connection exports never leave your machine.
- **Cost caps.** Per-run and per-day budgets, enforced before each paid call.
- **Fork-friendly.** Methodology lives in plain markdown ([methodology/](methodology/)); scoring models are YAML.

## Commands

| Skill | What it does |
|---|---|
| `/agentic-sales-engine:setup` | Create or check a workspace |
| `/agentic-sales-engine:icp-build` | Define your ICP from your site, materials and best customers; approve it (gate 1) |
| `/agentic-sales-engine:scoring-design` | Design Fit × Intent × Access factors, back-test on known customers, version changes |
| `/agentic-sales-engine:log-outcome` | Record meetings, wins and losses so scoring can recalibrate |
| `/agentic-sales-engine:status` | Funnel, gates, spend, next action |
| `/agentic-sales-engine:lint` | Knowledge-base health: unsourced, stale, duplicates, contradictions |
| `/agentic-sales-engine:dnc` | Manage the do-not-contact list |
| `/agentic-sales-engine:forget-person` | GDPR erasure |
| `/agentic-sales-engine:learn` | Teach the engine a correction or preference |
| *coming:* `import`, `discover`, `enrich-light`, `shortlist`, `research`, `score`, `ways-in` | |

## Development

```
bun install
bun test            # unit + hook tests
bun run typecheck
claude plugin validate .
claude --plugin-dir .   # try the plugin from a checkout, inside a workspace folder
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
