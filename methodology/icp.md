# ICP framework

An ICP describes the **companies** where you win fastest and biggest; **personas** describe the people inside them.
A good ICP is narrow enough to research deeply and broad enough to fill a pipeline (see market sizing).

## Building it — evidence first, questions last
1. **Your own materials** (website, decks, case studies): who do you already claim to serve, which problems, which proof?
2. **Best customers (lookalike analysis)**: research 3–10 customers the team considers ideal (and, if offered, 2–5 bad fits).
   Extract shared traits per dimension below and note which traits *separate* good from bad — those become scoring factors.
3. **Gap interview**: ask only what the evidence couldn't answer (deal size, sales cycle, who signs, why deals are lost).
   Every question is optional; unanswered gaps become explicit assumptions in the ICP.

## Dimensions
- **Firmographics**: industry (with NACE/NAICS codes where possible), size (employees and/or revenue), geography, ownership
  (family, PE, listed, public sector), growth stage.
- **Technographics**: systems they use that make you relevant (or that you integrate with), and gaps you fill.
- **Situational / triggers**: events that create urgency — funding, leadership change, expansion, M&A, regulation,
  hiring for roles that signal the problem, a failing incumbent.
- **Personas**: titles, role in the deal (economic buyer, champion, user, technical buyer, blocker), jobs, pains, gains.
- **Exclusions**: segments you can't serve or don't want (too small, regulated, competitors' captive customers…).

## Market sizing (sanity check)
Estimate how many companies match in the chosen geographies — from registries/statistics (counts by industry code ×
size band), provider result counts, or extrapolation from a sample search. Verdict:
- **too_narrow** (< ~150 accounts for a team): pipeline will dry up; relax a firmographic constraint.
- **too_broad** (> ~20,000): research cost explodes and messaging gets generic; add a situational qualifier.
State the method and its uncertainty; an order of magnitude is enough.

## Output
`icps/<slug>/icp.md` (frontmatter schema: see `templates/icp.md`) with evidence citations, plus `discovery_queries` —
natural-language queries the discover stage will run (one per sub-segment × geography).
