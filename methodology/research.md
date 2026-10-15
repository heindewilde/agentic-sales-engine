# Research practice

## Source hierarchy (default confidence)
1. First-party: the company's own site, filings, annual reports, official press releases — 0.9
2. Official registries (KBO/BCE, KvK, Companies House, SEC, Handelsregister) — 0.9
3. Reputable press and trade media — 0.7
4. Licensed data providers (Exa people index, Apollo, Crunchbase) — 0.6–0.7
5. Directories and aggregators — 0.5
6. Inference from indirect signals (job ads → tech stack) — 0.3, say so in `note`

Newer beats older at equal tier. When two sources disagree, keep both in the brief, cite both, and add an Open question.

## Depth ladder — use the cheapest step that answers the question
1. Search snippets (search result summaries) — enough for "does this exist / roughly what is it".
2. Page fetch of one known page (About, Team, Careers, Contact).
3. Structured extraction across a few pages into a schema.
4. Deep research agent — only for shortlisted accounts and only for questions 1–3 couldn't answer.

## Trigger taxonomy (signals)
funding · hiring (roles that signal the problem) · exec_change · expansion (new site, country, plant) · mna ·
launch · partnership · tech_change (migration, new system) · news (other material events).
Always date the event (not the article) and judge relevance per ICP (0–3).

## Wide funnel discovery
Run each ICP `discovery_query` per geography; dedupe by registrable domain; drop DNC and exclusions; stop when
new queries return mostly known domains. Record the query that found each account in `sources`.
