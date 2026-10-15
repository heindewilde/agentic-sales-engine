---
name: enrich-light
description: Cheap first-pass enrichment and light scoring of discovered accounts — confirms what each company does from its homepage, writes a cited snapshot, and scores only the rubric's light factors so the shortlist can be drawn. Use after discovery or a seed import; for more than ~15 accounts it runs as a batch.
argument-hint: "--icp <slug> [--unattended] [domain ...]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts *), Write, Read, WebFetch, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__estimate, mcp__plugin_agentic-sales-engine_ase__status
---

# Light enrichment + light score (wide funnel, step 2)

CLI: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts` (`ase` below). Cheap by design: one context call, one page-fetch
call, one structured write — never read or write account files one by one.

## Which accounts
- Domains in `$ARGUMENTS` → exactly those; otherwise `ase accounts --icp <slug> --stage discovered`.
- **More than ~15 and not `--unattended`:** run it as a batch instead — show the plan
  (`bun ${CLAUDE_PLUGIN_ROOT}/src/cli/batch.ts --skill enrich-light --icp <slug> --dry-run`), estimate ≈ $0.01–0.03
  per account, confirm the budget, then `batch.ts --skill enrich-light --icp <slug> --budget <usd>` and report its summary.

## Fast path (≤ 10 accounts per pass)
1. `ase context <domains…> --icp <slug> --mode light` → ICP essentials, the light `factors` to judge, `auto_factors`
   the engine scores itself from facts (e.g. company size from `employees` — just provide the fact), the `rules` digest,
   `learnings`, and each account's current facts.
2. For accounts whose facts don't yet answer the light factors: **one** `fetch_pages` call with all their homepages
   (add an About page only when the homepage is a shop front), `focus`: what the factors ask (e.g. "what the company
   does, customers, headcount, country, invoice-heavy business model"), `max_chars`: 2500. Tier T0: WebFetch.
3. Write **one** JSON file to `.ase/tmp/light-<first-domain>.json` with the Write tool:
   ```json
   {"icp":"<slug>","accounts":[{"domain":"a.com",
     "facts":{"industry":{"value":"food wholesale","source_url":"https://a.com/about","confidence":0.9,"raw_ref":"raw/…"},
              "employees":{"value":320,"source_url":"…","confidence":0.7}},
     "sections":{"Snapshot":"2–3 sentences: what they do, for whom, size, where.[^a1]"},
     "sources":{"a1":"About page, https://a.com/about (<today>)"},
     "judgements":[{"id":"industry_fit","level":3,"confidence":0.9,"evidence":[{"quote":"…","source_url":"…","raw_ref":"raw/…"}],"rationale":"…"}],
     "mode":"light","changelog":"enrich-light: snapshot + light score"}]}
   ```
   Judge only the ids in `factors` (rules digest applies; no evidence → `"level": null`). Footnote ids must be unique
   per account (use a letter prefix per account). Obvious non-matches: judge the knockout factor at 0 with evidence.
4. `ase apply .ase/tmp/light-<first-domain>.json` → per account `ok`, stage, score, or `errors`. Fix only the failed
   accounts and apply again with just those.
5. Reply with ≤ 3 lines: counts per tier, notable exclusions, failures. Next: `/agentic-sales-engine:shortlist --icp <slug>`.
