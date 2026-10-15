---
name: import
description: Import data into the sales workspace — seed lists of companies (Apollo, Sales Navigator, CRM or trade-fair exhibitor CSV exports) as ICP candidates, or a team member's LinkedIn Connections.csv export for warm-intro matching. Use when the user has a list of companies or their LinkedIn connections export.
argument-hint: "seeds <file.csv> --icp <slug> | connections <Connections.csv> --member <id>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Glob
---

# Import

Read `${CLAUDE_PLUGIN_ROOT}/references/rules.md` first.

## Seed lists → candidates
1. Peek at the file (first ~5 lines) to see its columns. Confirm which ICP it is for (ask if several are approved).
2. Run `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts import seeds <file> --icp <slug>`. Columns are auto-detected
   (company name, website/domain, country, employees, industry, LinkedIn…); if detection misses one, pass
   `--map name=<Column> --map domain=<Column>`. The file is copied to `imports/seeds/` so sources resolve for the team.
3. Report: rows, new accounts, accounts added to this ICP, already known, skipped (DNC / no domain). Rows without a
   website can't be deduplicated — offer to look up domains for them (cheap `discover_companies` by name) if many.
4. Next step: `/agentic-sales-engine:enrich-light`.

## LinkedIn connections → warm paths
1. How to export (tell the user if they don't have it): LinkedIn → Settings & Privacy → Data privacy → Get a copy of
   your data → **Connections** → request; the email arrives within ~10 minutes. Use `Connections.csv` from the zip.
2. Run `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts import connections <file> --member <member-id>`.
3. Explain the privacy model: the full export stays on this machine (`team/<member>/connections.csv`, gitignored);
   only connections at companies tracked in this workspace are written to the committed `warm-matches.yaml`.
   Email addresses from the export are never stored.
4. Matches refresh automatically after seed imports; after discovery runs use
   `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts connections match`.
