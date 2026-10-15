---
name: icp-build
description: Define or refine an Ideal Customer Profile — analyses your website and sales materials, researches your best (and worst) customers to find lookalike traits, interviews you only on remaining gaps, sanity-checks market size, and writes icps/<slug>/icp.md for approval. Use when starting out, entering a new segment, or when the user wants to define, review or change who they sell to.
argument-hint: "[icp-slug to refine]"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, WebSearch, WebFetch, mcp__plugin_agentic-sales-engine_ase__fetch_pages, mcp__plugin_agentic-sales-engine_ase__extract, mcp__plugin_agentic-sales-engine_ase__search_news, mcp__plugin_agentic-sales-engine_ase__discover_companies, mcp__plugin_agentic-sales-engine_ase__estimate, mcp__plugin_agentic-sales-engine_ase__status
---

# Build the ICP

Read first: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`, `${CLAUDE_PLUGIN_ROOT}/methodology/icp.md`,
`learnings/preferences.md`, `learnings/corrections.md`, `ase.config.yaml`, and any existing `icps/*/icp.md`
(refining `$ARGUMENTS` if given). Check budget with `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts ledger report`.

Principle: **evidence first, questions last.** Only ask the user what the evidence can't answer, and make every
question optional. Keep the user informed with one-line progress notes between steps.

## Step 1 — Who are we? (website + materials)
- Fetch the website in `ase.config.yaml` (homepage, about, product/solutions, customers/case studies, pricing, careers)
  via `fetch_pages` (T0: WebFetch). Read everything in `company/materials/` (PDF, decks, docs).
- Write `company/profile.md` (frontmatter `status: complete`): offering in one line, problems solved, who they claim to
  serve (industries, sizes, roles), proof points and named customers, differentiators, pricing / deal-shape signals,
  geographies. Footnote every claim with its URL or `import:company/materials/<file>`.
- Note the hypotheses this suggests (candidate segments) — don't decide yet.

## Step 2 — Lookalikes (optional, strongly recommended)
Ask once: "List 3–10 customers you'd love to clone (name or website) — and, if you can, 2–5 that were a bad fit.
Skip if you'd rather not." Write them to `icps/<slug>/known-customers.csv` (`domain,name,label,note`, label good|bad).
If you have to pick a slug before the ICP exists, use a short provisional one (e.g. `segment-1`) and keep it.
- Research each with the `icp-analyst` agent — run them in parallel (≤ 10 at a time), output to
  `icps/<slug>/calibration/research/<domain>.md`. Customers may be on the do-not-contact list; that's fine here.
- Build a trait table: rows = traits, columns = good vs bad customers. Identify **shared traits** among good customers
  and **separating traits** (present in good, absent in bad). Separating traits become scoring factors later.

## Step 3 — Gap interview (optional answers)
Use AskUserQuestion for at most ~6 questions, only on gaps, e.g.: typical deal size and sales cycle; who signs and who
champions; geographies to target now; segments to exclude (and why); why deals are lost; triggers they've seen precede a
purchase. Unanswered → record as an explicit assumption in the ICP body.

## Step 4 — Draft the ICP
- If the evidence shows two genuinely different segments (different buyers or problems), propose separate ICPs.
- Write `icps/<slug>/icp.md` following `${CLAUDE_PLUGIN_ROOT}/templates/icp.md`: `status: draft`, firmographics,
  technographics, triggers, personas (titles, role in deal, jobs, pains, gains), exclusions, and `evidence` facts.
- `discovery_queries`: 4–12 natural-language queries, one per sub-segment × country, phrased like a description of the
  company you want ("family-owned food wholesalers in Flanders with 100–500 employees").
- Body: why this segment (with citations), how to recognise a great fit, how to recognise a bad fit, assumptions.

## Step 5 — Market sizing
Estimate how many companies match per geography: official statistics/registries by industry code × size band
(search for them), or sample `discover_companies` queries and extrapolate. Record `market_size` with method and
verdict (too_narrow < ~150, too_broad > ~20,000 for a small team) and suggest how to adjust if off.

## Step 6 — GATE 1: approval
Present a one-screen summary: segment, size, geographies, personas, triggers, exclusions, market size, top assumptions.
Ask the user to approve, edit, or reject. On approval set `status: approved`, `approved_by: <member id>`,
`approved_at: <today>` (the hook refuses approval without an approver). Then add existing customers / competitors to
the do-not-contact list if they haven't been (`/agentic-sales-engine:dnc`), and suggest
`/agentic-sales-engine:scoring-design` next — the lookalike research from step 2 is reused there.
