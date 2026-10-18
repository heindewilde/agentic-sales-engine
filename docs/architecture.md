# Architecture

The engine is a Claude Code plugin (this repo) operating on a **workspace**: a separate git repository of markdown +
YAML files that holds one team's ICPs, accounts, people, signals, scores and learnings.

- **Skills** orchestrate each stage and stop at human gates.
- **Agents** do focused work (research one account, judge one factor) with restricted tools.
- **Hooks** guard the knowledge base (schema + provenance + DNC + privacy on every write) and keep the SQLite index fresh.
- **The `ase` CLI** does everything that must be exact: validation, indexing, scoring maths, budgets, imports, erasure.
- **The `ase` MCP server** is the only path to paid providers (Exa, Firecrawl): it holds the API keys, enforces budgets
  before each call and records actual cost.

## Components

### Repo layout (this repo = plugin + marketplace)
```
.claude-plugin/plugin.json         # name: agentic-sales-engine; userConfig: EXA_API_KEY, FIRECRAWL_API_KEY (sensitive), FIRECRAWL_BASE_URL, DEFAULT_RUN_BUDGET_USD
.claude-plugin/marketplace.json    # source "./" — repo is its own marketplace
.mcp.json                          # bundled stdio MCP server `ase` (src/mcp/server.ts) = provider gateway; keys via env ${user_config.*}
hooks/hooks.json
references/rules.md                # binding rules for every skill; its ## Digest is loaded by `ase context` (+ judging.md, output-format.md)
skills/<name>/SKILL.md (+references/)
agents/*.md
package.json, bun.lock, tsconfig.json   # pinned deps; installed into ${CLAUDE_PLUGIN_DATA} by SessionStart doctor if missing
src/core/                          # shared lib: frontmatter (yaml), paths, Fact model, zod schemas, db (bun:sqlite)
src/cli/*.ts                       # entrypoints, invoked as `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/<x>.ts`
src/hooks/*.ts                     # hook entrypoints (stdin JSON → decision JSON)
contracts/*.schema.json            # generated from zod schemas (zod-to-json-schema) for docs/validation
templates/                         # company.md, brief.md, person.md, signal.md, icp.md, scoring.yaml
workspace-template/                # scaffolded by /agentic-sales-engine:setup (incl. .claude/settings.json with extraKnownMarketplaces + enabledPlugins)
methodology/                       # ICP/persona framework, Fit×Intent×Access, SPIN/MEDDICC, cold-email frameworks
tests/{unit,hooks,e2e}, fixtures/workspace-ledgerly/, fixtures/cassettes/
.github/workflows/ci.yml           # bun test, tsc --noEmit, `claude plugin validate .`, schema lint
LICENSE (MIT), README.md, CONTRIBUTING.md, docs/
```

### Workspace layout (user data, separate git repo)
```
ase.config.yaml          # members, budgets/caps, privacy_mode, models per stage, provider prefs, default TTLs
company/profile.md, company/materials/
icps/<slug>/icp.md, scoring.yaml, scoring.history/, calibration.md, known-customers.csv
accounts/<domain>/company.md, brief.md, scores/<icp>.md, signals/<date>-<type>.md, notes.md
people/<linkedin-slug>.md
lists/<icp>/<run-id>/candidates.csv, shortlist.md, run.md
imports/seeds/*.csv
team/<member>/connections.csv   (gitignored)   team/<member>/warm-matches.yaml (committed, matches only)
raw/<yyyy-mm>/<sha>.md          # immutable source snapshots (cited excerpts + hash)
learnings/preferences.md, corrections.md     outcomes/outcomes.csv     dnc.yaml     ledger/costs.jsonl
index.md                         # generated LLM-wiki index
.ase/ase.db                      # gitignored derived SQLite index
```

### Knowledge harness
- **Fact object:** `{value, source_url, retrieved_at, confidence, ttl_days, method, raw_ref?}`. It is used for every structured field. `source_url` can also be `user:<member>` or `import:<file>`. Unsourced facts are rejected.
- **Account brief:** `accounts/<domain>/brief.md` is the handoff spine. It has fixed sections:
  - Snapshot
  - Business & offering
  - Situation & triggers
  - Technographics
  - People map
  - Ways in
  - Risks
  - **Open questions** (each tagged with the stage that owns it)
  - Changelog

  Each stage reads the open questions as its research agenda and appends new ones for the next stage.
- **Stage status:** stored per ICP in `company.md` as `icp_status.<icp>.stage`, and it only moves forward. A new signal re-triggers scoring.
- **SQLite tables:** accounts, account_icp, facts (with `expires_at`), people, warm_paths, signals, factor_scores, outcomes, dnc, ledger, runs, lint_issues, and an FTS5 table. All of them can be rebuilt from files.
- **Self-updating:**
  - `audit` checks for contradictions, stale facts past their TTL, orphans and missing citations.
  - `refresh` re-researches expired facts.
  - `learn` turns user corrections and edits into `learnings/` entries, which every skill reads.
  - Monitoring and outcome recalibration come in later milestones.

### Stage contracts (JSON Schema in `contracts/`, checked by `validate --stage`)
| Stage | Writes | Gate |
|---|---|---|
| S0 ICP build | icp.md (draft) | **GATE 1: user approves the ICP** |
| S0b Scoring design | scoring.yaml v1, calibration.md | user accepts the back-test |
| S1 Discover (Exa + seed CSVs, deduped by domain, DNC dropped) | company stubs, candidates.csv | — |
| S2 Light enrich and light score (Haiku, homepage and firmographics, `light: true` factors only) | facts, brief Snapshot, scores (light) | — |
| S3 Shortlist (ranked, with a p50/p90 cost estimate) | shortlist.md | **GATE 2: user approves the accounts (and, with API billing, the budget)** |
| S4 Deep research (Exa Agent / Firecrawl extraction, people, signals) | brief sections, people/, signals/, raw/ | — |
| S5 Full score | scores/<icp>.md (full) | **GATE 3: user reviews the scores before ways in and outreach** |
| S6 Ways in (warm paths and trigger hooks) | brief "Ways in" | — |
| S7 Outreach | drafts/ with status draft, never sent | **draft review: a person edits and sends** |
| S8 Call prep | callprep/<date>.md | — |

### Scoring model
- **Structure:** `scoring.yaml` holds the groups fit, intent and access, each with a weight. Each factor has:
  - a weight
  - a group
  - a `light` flag
  - an optional knockout
  - an `unknown_prior`
  - anchored level descriptions from 0 to 3
  - an `evidence_hint`

  Every version is archived.
- **Judging:** the `factor-judge` agent judges one factor at a time. It returns a level, or `null`, plus quoted evidence with a `source_url` and a confidence. A level without evidence is converted to `null`.
- **Calculation:** `score compute` is deterministic.
  - An unknown level uses `unknown_prior` (default 1). It is not counted as 0.
  - Confidence-weighted: `w_eff = w·(0.5+0.5·conf)`.
  - It outputs `total`, `upside` (the score if every unknown were 3), `coverage` and `tier`.
  - A knockout applies only when the level is known. An unknown knockout factor gets the flag `needs_check`.
- **Help defining the method (`icp` skill, scoring phase):**
  1. Propose 8–12 factors from the ICP.
  2. `score backtest` on the known good and bad customers: AUC, precision@k, and the percentile of the known-good accounts (target ≥75th).
  3. `score sensitivity`: ±20% weights and leave-one-factor-out, measured with Kendall τ, to flag factors that change nothing and factors that dominate.
  4. Iterate with the user.
- **Later:** `score recalibrate` uses L2 logistic regression on 30 or more outcomes and *proposes* a weight diff. It never applies it automatically.
- **Stats code:** AUC, Kendall τ and logistic regression (gradient descent) are hand-written in `src/core/stats.ts`, about 150 lines, and fully unit-tested against known values. This avoids a heavy dependency.

### Providers & cost
- `src/core/providers/` defines the operations `discover_companies`, `find_people`, `extract(url, schema)`, `research(account, effort)`, `search_news(since)` and `watch(target)`.
- It has three adapters:
  - **Exa:** search categories company, people and news (with date filters), Agent, and Monitors.
  - **Firecrawl:** scrape/crawl with JSON schema, and Monitor. It supports the self-hosted base URL.
  - **Replay:** cassettes for tests and offline use.
- Each operation writes a raw snapshot and a ledger entry.
- **Capability tiers,** detected at SessionStart:
  - T0: no keys. WebSearch, WebFetch and CSV imports only.
  - T1: one key.
  - T2: both keys.
- **Provider gateway = bundled stdio MCP server `ase`** (`src/mcp/server.ts`), wrapping `exa-js` / `@mendable/firecrawl-js`. Reason: sensitive userConfig keys only reach processes via `${user_config.*}` in `.mcp.json` env — not Bash-run scripts. The gateway enforces run/day budgets *before* each call and records actual cost (Exa returns costDollars) in the ledger. CLI scripts fall back to `EXA_API_KEY`/`FIRECRAWL_API_KEY` from the shell env; batch runs pass keys via Agent SDK `options.env`.
- **`ledger`:** `estimate`, `check`, `record` and `report`. Budgets are set per run and per day in `ase.config.yaml`.

### Batch execution
- **Hundreds of accounts:** `src/cli/batch.ts` runs as the driver. It uses the **Claude Agent SDK (TypeScript)** and loads the plugin for each chunk of accounts, 4 at a time by default, with a per-session budget cap and cost tracking from the SDK result messages. If the SDK is unavailable it falls back to `claude -p --plugin-dir`.
  - It is resumable, because it reads stage state from the files.
  - It enforces the budget twice: a hard per-call cap and the ledger.
  - It behaves the same locally and in GitHub Actions.
- **20 accounts or fewer, interactive:** in-session subagent fan-out.
- **Optional later:** Workflow scripts in `workflows/`.

### Components
- **Skills (17, since 0.11):** `setup`, `autopilot`, `status`; `icp` (ICP, gate 1, scoring model, calibration,
  recalibration); `discover` (incl. seed CSVs); `enrich-light`; `shortlist`; `research`; `score`; `ways-in` (incl.
  Connections.csv); `draft-outreach`; `call-prep`; `refresh` (watchlist + TTL); `outcomes` (log, weekly review,
  win-loss); `learn` (incl. voice); `audit` (lint + evals); `privacy` (DNC + erasure).
- **Agents:** `icp-analyst`, `account-researcher`, `people-finder`, `signal-scout`, `factor-judge`, `wiki-linter`. Tools are restricted per agent. Only the researcher and analyst agents call providers; light enrichment runs in the enrich-light skill itself (batched).
- **Hooks** (all are `bun src/hooks/<x>.ts`):
  - **PreToolUse on Write|Edit** runs `validate`, which denies:
    - unsourced facts
    - schema violations
    - writes for DNC entities
    - personal emails when privacy mode is on
    - any edit to `raw/`
  - **PostToolUse on Write|Edit** runs `reindex --path`.
  - **SessionStart** runs `doctor --brief`, which reports the tier, budget left, stale facts and pending gates. It also runs `bun install --frozen-lockfile` into `${CLAUDE_PLUGIN_DATA}` when dependencies are missing.
  - Hooks import only `src/core` plus `yaml` and `zod`. Bun's startup of about 10 ms keeps per-write hooks cheap.
- **CLI entrypoints:**
  - providers and ledger
  - imports: `import-csv`, and `import-connections` (which skips the `Notes:` preamble)
  - `dedupe` (domain normalization with `tldts`, LinkedIn URL normalization)
  - `score`, `reindex`, `validate`, `lint`, `ttl`, `forget`, `batch`, `doctor`, `export`
- **Key dependencies:** `yaml`, `zod`, `zod-to-json-schema`, `tldts`, `csv-parse`, `exa-js`, `@mendable/firecrawl-js`, `@anthropic-ai/claude-agent-sdk`. The SQLite index uses Bun's built-in `bun:sqlite`.

## Milestones
- **M0, skeleton:**
  - Bun/TS project, manifest, marketplace, workspace template, shared rules
  - methodology docs
  - CI with `bun test`, `tsc` and `claude plugin validate`
  - the fixture workspace
  - **Spike:** check whether plugin hooks fire in Agent SDK batch sessions. If not, `batch.ts` validates and reindexes after each chunk.
- **M1, knowledge harness:** `src/core`, zod schemas and contracts, `validate`, hooks, `reindex`, `lint`, `dnc`, `forget-person`.
- **M2, providers and cost:** providers with the Exa, Firecrawl and replay adapters, the ledger, the budget hook, tier detection in doctor.
- **M3, ICP builder:** website and materials, then lookalikes, then the gap interview, plus the market-size check and GATE 1.
- **M4, scoring design:** `score` (compute, backtest, sensitivity), `stats.ts`, `factor-judge`, the `scoring-design` skill.
- **M5, wide funnel:** imports, discover, `batch.ts`, light enrich and score, shortlist with GATE 2.
- **M6, deep funnel:** research, people, signals, full score, Connections import, ways-in. **v1.0 release.**
- **M7, freshness:** TTL refresh, Exa Monitors and Firecrawl Monitor, `/sync`, a GitHub Actions cron example.
- **M8:** outreach (voice profile, drafts, learning from edit diffs).
- **M9:** call prep (one-page briefing, SPIN/MEDDICC questions, objections).
- **M10:** recalibration from outcomes, plus Apollo, PDL and Crunchbase adapters.

