---
name: setup
description: Create or check a sales-engine workspace — scaffolds the folder structure, team members, budgets and provider keys. Use when starting with the agentic sales engine, when no ase.config.yaml exists, or when the user asks to set up or check their sales workspace.
argument-hint: "[target directory]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit
---

# Set up a sales-engine workspace

First read `${CLAUDE_PLUGIN_ROOT}/references/rules.md`.

## 1. Existing workspace?
Run `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts doctor --text`. If it reports a workspace, show the summary, fix any
reported problems with the user, and skip to step 4.

## 2. Gather the basics (one short message, all optional except the name)
- Company name and website (the ICP builder starts from the website).
- Team members who will use this workspace (`id:Full Name`, ids lowercase).
- Target directory — default: `$ARGUMENTS` or the current directory if it is empty, otherwise `./sales-workspace`.

## 3. Scaffold
```
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts init <dir> --name "<company>" --website <url> --member <id:Name> [--member ...]
```
This copies the workspace template, writes `ase.config.yaml`, runs `git init` and builds the index.
Tell the user to open Claude Code **in that directory** for future sessions (the workspace's `.claude/settings.json`
enables this plugin for everyone who clones it).

## 4. Providers & budgets
Explain the provider tiers in two lines and show the current one from `doctor`:
- **T2** Exa + Firecrawl (recommended): discovery, people, news, deep research, site extraction, monitoring.
- **T1** one key; **T0** no keys — works on built-in web search and CSV imports, slower and shallower.
Keys are entered via `/plugin` → agentic-sales-engine → configure (stored in the OS keychain, never in files).
Free tiers: Exa gives $10/month credit, Firecrawl 1,000 credits/month.

Confirm budget caps in `ase.config.yaml` (`per_run_usd`, `per_day_usd`) and privacy mode (on by default; point EU
teams to `LEGITIMATE-INTEREST.md`).

## 5. Next step
Suggest `/agentic-sales-engine:icp-build`, and that they can already drop sales decks / case studies into
`company/materials/` and a list of best customers into `icps/<slug>/known-customers.csv` later.
