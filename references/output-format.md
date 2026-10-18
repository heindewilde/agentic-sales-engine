# Output format: the `ase apply` file

Every stage that writes account knowledge (enrich-light, research, score, ways-in) writes **one JSON file** and runs
`bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts apply <file>`. `apply` validates it, writes the brief, facts, people, signals and score,
and checks every quote against the saved page. It reports per account `ok`, the new stage and score, or `errors`: fix
only the failed accounts and apply again with just those. Never edit account files by hand.

## Example (all fields; use only what your stage produces)

```json
{"icp": "<icp slug>", "accounts": [{
  "domain": "acme.example",
  "facts": {
    "employees": {"value": 45, "source_url": "https://acme.example/about", "confidence": 0.9, "raw_ref": "raw/2026-10/abc123.md"},
    "hq_country": {"value": "NL", "source_url": "https://acme.example/contact", "confidence": 0.9}
  },
  "sections": {
    "Snapshot": "Amsterdam maker of workwear for bakers, 45 staff.[^a1]",
    "Situation & triggers": "2026-09-01: opened a second warehouse in Antwerp.[^a2]",
    "People map": "Head of E-commerce: Jane Doe (people/jane-doe-1a2b.md).[^a3]",
    "Risks & fit concerns": "Sells mostly B2B; webshop is small.[^a1]"
  },
  "sources": {
    "a1": {"label": "About page", "url": "https://acme.example/about", "date": "2026-10-17", "quote": "Since 2011 our team of 45 has made workwear for bakers", "raw_ref": "raw/2026-10/abc123.md"},
    "a2": {"label": "News", "url": "https://acme.example/news/antwerp", "date": "2026-10-17", "quote": "On 1 September 2026 we opened our Antwerp warehouse", "raw_ref": "raw/2026-10/def456.md"},
    "a3": {"label": "Team page", "url": "https://acme.example/team", "date": "2026-10-17", "quote": "Jane Doe, Head of E-commerce", "raw_ref": "raw/2026-10/ghi789.md"}
  },
  "open_questions": [
    "- [x] Who runs e-commerce? → Jane Doe[^a3]",
    "- [ ] Is photography done in-house? (unknown after research; owner: ways-in)"
  ],
  "people": [
    {"name": "Jane Doe", "title": "Head of E-commerce", "linkedin_url": "https://www.linkedin.com/in/janedoe", "persona": "ecommerce_lead", "seniority": "director", "source_url": "https://acme.example/team", "confidence": 0.9, "raw_ref": "raw/2026-10/ghi789.md"}
  ],
  "signals": [
    {"type": "expansion", "title": "Second warehouse in Antwerp", "date": "2026-09-01", "source_url": "https://acme.example/news/antwerp", "confidence": 0.9, "relevance": 2, "raw_ref": "raw/2026-10/def456.md"}
  ],
  "judgements": [
    {"id": "company_size", "level": 3, "confidence": 0.9, "evidence": [{"quote": "our team of 45", "source_url": "https://acme.example/about", "raw_ref": "raw/2026-10/abc123.md"}], "rationale": "45 staff is the core of the 20-100 band."}
  ],
  "mode": "full",
  "stage": "researched",
  "changelog": "research: brief, people, signals, full score"
}]}
```

## Fields
- **facts:** `{value, source_url, confidence[, raw_ref, ttl_days, method, note]}`. `source_url` may be `user:<member>` or
  `import:<workspace path>`.
- **sections:** brief sections by heading: `Snapshot` (one paragraph: what, size, where, why they might fit),
  `Business & offering`, `Situation & triggers` (every event dated), `Technographics`, `People map` (persona → named
  person, role, how reachable), `Ways in` (warm paths, trigger hooks, shared context, ranked), `Risks & fit concerns`.
  Every statement carries a footnote `[^id]`; ids are unique per account (use a letter prefix per account in a chunk).
- **sources:** each footnote `{label, url, date, quote, raw_ref}`. The quote is the exact words on that page the
  statement rests on (≤ 40 words); every detail in the statement (a number, a country, a role, a date) must be inside
  one of its footnotes' quotes. `apply` rejects a quote that isn't on the saved page.
- **open_questions:** replaces the section. Answered: `- [x] question → answer[^id]`. Open: `- [ ] question (owner: <stage>)`.
- **people:** business data only (see rules). `seniority`: c_level, vp, director, manager, ic, owner, other.
- **signals:** `type`: funding, hiring, exec_change, expansion, mna, launch, partnership, tech_change, news, other.
  Date the event, not the article. `relevance` 0–3 for this ICP.
- **judgements + mode:** factor scores, judged as `references/judging.md` describes. `mode: light` scores only the
  light factors, `full` all of them. Leave both out when your stage doesn't score.
- **stage:** `researched` or `outreach_ready`, applied only when the stage contract holds. Ways in sets `outreach_ready` by itself; `scored` holds an account back.
