# Research practice

## Source hierarchy
Confidence follows the one scale in `references/rules.md`:
1. **0.9** First-party: the company's own site, filings, annual reports, official press releases; official registries
   (KBO/BCE, KvK, Companies House, SEC, Handelsregister).
2. **0.7** Reputable press and trade media; licensed data providers (Exa people index, Apollo, Crunchbase).
3. **0.5** Directories and aggregators.
4. **0.3** Inference from indirect signals (job ads → tech stack); say so in `note`.

Newer beats older at equal tier. When two sources disagree, keep both in the brief, cite both, and add an Open question.

## Depth ladder: use the cheapest step that answers the question
1. Search snippets: enough for "does this exist / roughly what is it".
2. One page fetch of a known page (About, Team, Careers, Contact), with a `focus` and `max_chars` 1500.
3. Structured extraction across a few pages into a small schema.
4. The deep research agent: only for shortlisted accounts and only for questions 1–3 couldn't answer, with a focused
   question list and `effort: low` or `medium`. Cite its citations, not its prose.

## Researching one account
The brief's **Open questions** and each scoring factor's `evidence_hint` are the agenda. Stop each line when answered.
1. **Own site:** one `fetch_pages` for About, Team/Management, Careers/Jobs, Locations, News/Press, Customers (up to
   ~6 URLs). Job ads reveal systems and pains; leadership pages reveal people. Include the page that settles a factor
   whose level 0 is an absence (e.g. careers for hiring factors), so "checked, not there" can be judged; when a factor
   needs prices, one product or collection page.
2. **Triggers:** `search_news` for the company since 18 months ago, once more in the local language if not English.
3. **Missing facts** for scoring factors (size, ownership, systems): `extract` on the 1–3 most promising URLs, or one
   targeted search (registries, press).
4. **People:** per ICP persona, `find_people` ("<title> at <company> <country>"). Keep 1–3 people per persona whose
   current employer is clearly this account; business data only; check do-not-contact first.
5. **Deep agent** only if important open questions remain.

Every open question ends answered (`- [x] … → answer[^id]`) or carried forward
(`- [ ] … (unknown after research; owner: <stage>)`).

## Trigger taxonomy (signals)
funding · hiring (roles that signal the problem) · exec_change · expansion (new site, country, plant) · mna ·
launch · partnership · tech_change (migration, new system) · news (other material events) · other.
Always date the event (not the article) and judge relevance per ICP (0–3).

## Wide funnel discovery
Run each ICP `discovery_query` per geography; dedupe by registrable domain; drop DNC and exclusions; stop when
new queries return mostly known domains. Record the query that found each account in `sources`.
