---
name: enrich-light
description: Cheap first-pass enrichment and light scoring of discovered accounts — confirms what each company does from its homepage, writes a cited snapshot, and scores only the rubric's light factors so the shortlist can be drawn. Use after discovery or a seed import; for more than ~15 accounts it runs as a batch.
argument-hint: "--icp <slug> [--unattended] [domain ...]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts *), Read, Write, Edit, Glob, Grep, WebFetch, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__estimate, mcp__plugin_agentic-sales-engine_ase__status
---

# Light enrichment + light score (wide funnel, step 2)

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/references/judging.md`,
`icps/<slug>/scoring.yaml` (light factors), `icps/<slug>/icp.md` exclusions, learnings files.
CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below).

## Which accounts
- Domains given in `$ARGUMENTS` → exactly those. Otherwise `ase accounts --icp <slug> --stage discovered`.
- **More than ~15 and not `--unattended`:** don't do them in this session. Show the count and the batch plan
  (`bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts --skill enrich-light --icp <slug> --dry-run`), estimate
  ≈ $0.01–0.03 per account, confirm the budget with the user, then run the batch with `--budget <usd>` and report
  its summary. Batch runs need provider keys in the shell environment or the workspace `.env`.

## Per account (keep it cheap: ≤ 2 page fetches)
1. Read `accounts/<d>/company.md` and `brief.md`.
2. If the description, size, country or business model is missing or vague: `fetch_pages` for the homepage and, if
   needed, one About/Company page (T0: WebFetch + save a raw snapshot). Skip fetching when the discovery summary
   already answers the light factors.
3. Update `company.md` facts you can now cite (`industry`, `business_model`, `employees`, `hq_country`…, with
   `raw_ref`). Never overwrite a higher-confidence fact with a lower one.
4. Write the brief **Snapshot** (2–4 sentences: what they do, for whom, size, where — footnoted), set
   `sections_updated.Snapshot: <today>`, add a Changelog line `- <today> enrich-light: …`. If something important is
   unclear, add an Open question (owner: research).
5. Judge the **light** factors per judging.md, write the JSON to `.ase/tmp/<domain>-<mode>.json`, run
   `ase score compute --icp <slug> --account <d> --mode light --judgements <file>`. This sets `light_scored`
   (or `excluded` on a known knockout).
6. Obvious non-matches (not a company, wrong country, out of business): judge the knockout factor at 0 with the
   evidence — don't skip them silently.

## Finish
Report counts per tier (A/B/C/X), notable exclusions, and spend. In `--unattended` mode just print a 3-line summary.
Next: `/agentic-sales-engine:shortlist --icp <slug>`.
