# Claude Managed Agents (owner's setup)

An optional way to run the research slice on Anthropic's hosted agent platform instead of in Claude Code. The plugin is
unchanged; this is for comparing runtimes. Billed to the Claude Console workspace of `ASE_MANAGED_AGENTS_API_KEY`
(on a Max plan: the monthly API credits).

```bash
bun src/managed/cli.ts sync        # agents/*.md → versioned managed agents; creates the environment and the key vault
bun src/managed/cli.ts run --repo owner/workspace-repo --icp <slug> <domain...> [--base master] [--cap 5]
bun src/managed/cli.ts telemetry   # platform traces → Braintrust (needs ASE_ANTHROPIC_ADMIN_KEY once; revoke it after)
bun src/managed/cli.ts status
```

## How it maps

| Plugin | Managed Agents |
|---|---|
| `agents/account-researcher.md`, `agents/factor-judge.md` | agents `ase-account-researcher` (with the judge as its subagent) and `ase-factor-judge`. A changed file → a new immutable version on `sync`; runs pin a version. |
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
