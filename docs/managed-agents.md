# Claude Managed Agents (owner's setup)

An optional way to run the engine on Anthropic's hosted agent platform instead of in Claude Code. The plugin is
unchanged; this is for comparing runtimes. Every skill runs there, by name. Billed to the Claude Console workspace of `ASE_MANAGED_AGENTS_API_KEY`
(on a Max plan: the monthly API credits).

```bash
bun src/managed/cli.ts sync        # agents/*.md + skills/* → versioned agents and skills, plus the operator, environment and key vault
bun src/managed/cli.ts run <skill> [skill args...] --repo owner/workspace-repo [--base master] [--cap 5]
bun src/managed/cli.ts reply <session-id> "<answer>"   # a run that asked a question (gate, choice) continues
bun src/managed/cli.ts schedule <skill> [args...] --cron "0 7 * * 1" --repo owner/workspace-repo [--cap 2]   # recurring
bun src/managed/cli.ts inbox [days]   # finished runs nobody listened to (scheduled ones too) → pull requests; open questions
bun src/managed/cli.ts telemetry   # platform traces → Braintrust (needs ASE_ANTHROPIC_ADMIN_KEY once; revoke it after)
bun src/managed/cli.ts status
```

## How it maps

| Plugin | Managed Agents |
|---|---|
| Claude Code session running the plugin | agent `ase-operator`: every skill attached, the four agents as subagents, itself for parallel chunks |
| `agents/*.md` | agents `ase-account-researcher`, `ase-factor-judge`, `ase-icp-analyst`, `ase-wiki-linter`. A changed file → a new immutable version on `sync`; runs pin a version. |
| `skills/*/SKILL.md` | platform skills, same text (plugin root path rewritten); a changed skill → a new skill version |
| `batch.ts` / `claude -p` | subagents: one researcher per account, enrich-light in chunks of 10 |
| `AskUserQuestion`, gates | the run stops with a question (`status: question`); `reply` answers it |
| cron / "run every Monday" | `schedule`: a platform deployment; each run on its own branch, `inbox` opens the pull requests |
| reviewing what an agent did | every finished run opens a pull request: the agent's summary, scores before → after, cost, session link |
| MCP gateway (`fetch_pages`, `search_news`, …) | the same gateway through the CLI (`ase provider <op>`), because hosted agents only take remote MCP servers |
| Exa/Firecrawl keys | a vault: the sandbox sees a placeholder, the real key is added only on requests to api.exa.ai / api.firecrawl.dev |
| workspace on disk | the workspace's GitHub repo, mounted in the sandbox; results are pushed to a `managed/…` branch for review, never to the base branch |
| engine code | cloned from GitHub at the exact local commit (so push first) |

## Credentials (`~/.config/agentic-sales-engine/credentials.env`)

- `ASE_MANAGED_AGENTS_API_KEY`: a Console key scoped to a workspace. **Not** `ANTHROPIC_API_KEY`: that name switches the
  plugin and `claude -p` from the subscription to API billing.
- `ASE_MANAGED_AGENTS_GITHUB_TOKEN`: a fine-grained token for the workspace repo only, Contents read+write.
- `ASE_ANTHROPIC_ADMIN_KEY`: only for `telemetry`, once.

Platform IDs are kept in `~/.config/agentic-sales-engine/managed.json`. Networking is open (research reads any company
site), so a malicious page could try to steer the agent; it can only push to its own branch.

## Tested (2026-10-18, Shotlift workspace)

Every skill ran once on the platform (`forget-person` excluded: it erases real personal data). All finished `done`;
skills without the input they need (call-prep without a meeting, log-outcome without an event, import without a file)
stopped instead of inventing it. Claude cost per run, from the API credits:

| Skill | Cost | | Skill | Cost |
|---|---|---|---|---|
| status | $0.04–0.09 | | discover (289 candidates) | $0.16 |
| dnc, setup, review-outcomes, log-outcome | $0.02–0.04 | | enrich-light (4 accounts) | $0.32 |
| ways-in, draft-outreach, call-prep | $0.08–0.12 | | score (1 account) | $0.21 |
| learn, icp-build, voice-profile, import | $0.04–0.11 | | scoring-design (diagnosis) | $0.33 |
| shortlist (proposal + gate) | $0.08–0.19 | | refresh | $0.95 |
| evals (offline suite) | $0.15 | | research (2 accounts) | $0.99 |
| win-loss | $0.13 | | sync | > $1.20 (cap; re-scores after new signals) |
| autopilot (stops at its gate) | $0.07 | | lint (before scoping the semantic pass) | > $2 (cap) |

Research per account: $1.08 (first run) → $0.67 → $0.51 (one researcher per account, evidence pack for the judge).

## Schedules

| Skill | When (Europe/Amsterdam) | Cap per run |
|---|---|---|
| sync `--icp fashion-midhigh-benelux` | Monday 07:00 | $3 |
| lint `--mechanical` (plain code, no semantic pass) | Sunday 07:00 | $0.50 (a run costs ~$0.05) |
| refresh `--icp fashion-midhigh-benelux` | 1st of the month, 07:00 | $3 |

`inbox` turns finished scheduled runs into pull requests. Pause one in the Console (Deployments) or archive it.

## Agent map

```bash
bun src/managed/cli.ts map --workspace ~/Projects/shotlift-sales   # http://127.0.0.1:4317; the workspace is remembered
```

A local, read-only dashboard of how the engine works and how it's doing:
- **Process:** a swimlane of the whole journey (steps as rows; You, Coordinator, Researcher, Judge, Auditor, ICP analyst
  as lanes), with your decisions in black and live accounts and cost per step.
- **Pipeline:** accounts that reached each stage, from the workspace, with conversion.
- **Cost per run, by step:** stacked by agent.
- **Research hand-off:** the sequence of messages between you, the Coordinator, the Researchers, the Judges and the PR.
- **Agents** and **Activity** (every run over time, coloured by outcome).
- Click a step, agent or run for the details: in/out, hand-offs, runs, things to double-check, versions and changes.

The process text lives in `src/map/process.ts`; keep it in step with the skills.
