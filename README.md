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

> **Status:** v1 feature set complete (M0–M6): ICP → scoring design → discover → light score → shortlist → deep research →
> full score → ways in, with the knowledge harness, provider gateway and batch driver. Verified end-to-end in real Claude
> sessions at tier T0; live Exa/Firecrawl calls are unit-tested but not yet exercised against the real APIs.
> Next: freshness monitoring (M7), outreach drafts (M8), call prep (M9). See [docs/architecture.md](docs/architecture.md).

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

Large lists run as batches of headless sessions:
`bun <plugin>/src/cli/batch.ts --skill enrich-light|research|score --icp <slug> --budget 5` (resumable, budget-capped).

Without keys the engine runs on Claude Code's built-in web search and your CSV imports (slower, shallower).
For CLI/batch runs outside Claude Code, put `EXA_API_KEY` / `FIRECRAWL_API_KEY` in a gitignored `.env` in the workspace.

## How a run flows

```
icp-build ─GATE 1─▶ scoring-design ─▶ discover / import ─▶ enrich-light ─▶ shortlist ─GATE 2─▶ research ─▶ score ─▶ ways-in
   (approve ICP)     (back-test)        (wide: 200–1000)    (cheap, batched)  (cost estimate)    (deep, cited)          (warm paths, triggers)
```

Every account carries a `brief.md` whose **Open questions** are the next stage's research agenda, and a stage only
advances when its handoff contract holds (`ase validate --stage`).

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
| `/agentic-sales-engine:import` | Add seed lists (Apollo, Sales Nav, fair exhibitors) or a LinkedIn connections export |
| `/agentic-sales-engine:discover` | Find companies matching an approved ICP, deduplicated against your workspace |
| `/agentic-sales-engine:enrich-light` | Cheap snapshot + light score per account (batches for large lists) |
| `/agentic-sales-engine:shortlist` | Pick accounts for deep research with a cost estimate; approve (gate 2) |
| `/agentic-sales-engine:research` | Deep research on approved accounts: triggers, buying committee, systems, risks → full score |
| `/agentic-sales-engine:score` | Full (re)score; `--explain` tells you what drives an account's score |
| `/agentic-sales-engine:ways-in` | Rank warm intros and trigger hooks per account, written into the brief |
| `/agentic-sales-engine:refresh` | Re-verify facts past their TTL, catch new triggers, rescore |
| `/agentic-sales-engine:log-outcome` | Record meetings, wins and losses so scoring can recalibrate |
| `/agentic-sales-engine:status` | Funnel, gates, spend, next action |
| `/agentic-sales-engine:lint` | Knowledge-base health: unsourced, stale, duplicates, contradictions |
| `/agentic-sales-engine:dnc` | Manage the do-not-contact list |
| `/agentic-sales-engine:forget-person` | GDPR erasure |
| `/agentic-sales-engine:learn` | Teach the engine a correction or preference |
| *coming:* signal monitoring (`sync`), outreach drafts in your voice, call prep | |

## Development

```
bun install
bun test            # unit + hook tests
bun run typecheck
claude plugin validate .
claude --plugin-dir .   # try the plugin from a checkout, inside a workspace folder
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
