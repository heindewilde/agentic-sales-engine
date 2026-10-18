# Claude Managed Agents (owner's setup)

An optional way to run the engine on Anthropic's hosted agent platform instead of in Claude Code. The plugin is
unchanged; this is for comparing runtimes. Every skill runs there, by name. Billed to the Claude Console workspace of `ASE_MANAGED_AGENTS_API_KEY`
(on a Max plan: the monthly API credits).

```bash
bun src/managed/cli.ts sync        # agents/*.md + skills/* → versioned agents and skills, plus the operator, environment and key vault
bun src/managed/cli.ts run <skill> [skill args...] --repo owner/workspace-repo [--base master] [--cap 5]
bun src/managed/cli.ts reply <session-id> "<answer>"   # a run that asked a question (gate, choice) continues
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
