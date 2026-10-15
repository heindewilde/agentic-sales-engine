# Scheduling the sales engine

Monitoring (`sync`) and freshness (`refresh`) are most useful on a schedule. Scheduled runs are **unattended**:
they never pass a human gate, never send anything, and stop at the run budget.

## Option 1 — your machine (simplest)

Keys come from `~/.config/agentic-sales-engine/credentials.env` (`ase keys status`).

```bash
# crontab -e  → every Monday 07:00
0 7 * * 1 cd ~/sales-workspace && claude -p "/agentic-sales-engine:sync --unattended" \
  --permission-mode dontAsk --max-budget-usd 2 \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(bun *),mcp__plugin_agentic-sales-engine_ase" \
  >> .ase/sync.log 2>&1
```

Or without Claude at all, just the polling part (no judging — items wait in `sync/` for the next interactive session):

```bash
0 7 * * 1 cd ~/sales-workspace && bun <plugin-dir>/src/cli/ase.ts sync >> .ase/sync.log 2>&1
```

## Option 2 — GitHub Actions (team workspace on GitHub)

`.github/workflows/sales-sync.yml` in the workspace repo:

```yaml
name: sales-sync
on:
  schedule: [{ cron: "0 6 * * 1" }]   # Mondays 06:00 UTC
  workflow_dispatch:
permissions: { contents: write }
jobs:
  sync:
    runs-on: ubuntu-latest
    env:
      # The plugin's MCP gateway falls back to ASE_* variables when no plugin config is present.
      ASE_EXA_API_KEY: ${{ secrets.EXA_API_KEY }}
      ASE_FIRECRAWL_API_KEY: ${{ secrets.FIRECRAWL_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          plugin_marketplaces: heindewilde/agentic-sales-engine
          plugins: agentic-sales-engine@agentic-sales-engine
          prompt: "/agentic-sales-engine:sync --unattended"
          claude_args: "--max-budget-usd 2"
      - name: Commit results
        run: |
          git config user.name "sales-engine-bot"
          git config user.email "bot@users.noreply.github.com"
          git add -A && git commit -m "sync $(date -u +%F)" || echo "nothing new"
          git push
```

Notes:
- The SQLite index (`.ase/`) is rebuilt on each run and never committed; the page-diff cache is local too, so in CI a
  changed page is reported with its new snapshot (`raw_ref`) rather than a line diff.
- Verify the first run by hand (workflow_dispatch) and check `ase ledger report` afterwards.
- For larger lists, run `bun <plugin>/src/cli/batch.ts --skill score --icp <slug>` after sync to rescore in batches.
