---
icp: ap-automation-midmarket
account: maasverhoeven.example
scoring_version: 1
mode: full
total: 57
upside: 70.8
coverage: 0.78
tier: B
knocked_out: []
needs_check:
  - no_ap_tool
scored_at: 2026-10-15T14:44:51.234Z
factors:
  - id: company_size
    level: 3
    confidence: 0.9
    evidence:
      - quote: with approximately 310 employees
        source_url: https://maasverhoeven.example/about
        raw_ref: raw/2026-10/a1b2c3d4e5f6.md
    rationale: 310 is inside 150–700.
  - id: industry_fit
    level: 3
    confidence: 0.9
    evidence:
      - quote: family-owned B2B food wholesaler
        source_url: https://maasverhoeven.example/about
        raw_ref: raw/2026-10/a1b2c3d4e5f6.md
    rationale: Wholesale is a top-anchor industry.
  - id: erp_fit
    level: null
    confidence: 0
    evidence: []
    rationale: No source on the ERP.
  - id: no_ap_tool
    level: null
    confidence: 0
    evidence: []
    rationale: No evidence either way.
  - id: finance_change
    level: 3
    confidence: 0.9
    evidence:
      - quote: has acquired Delcourt Traiteur in Liège
        source_url: https://news.example/maas-verhoeven-acquires-delcourt
        raw_ref: raw/2026-10/c3d4e5f6a1b2.md
    rationale: Acquisition within 6 months.
  - id: ap_hiring
    level: 0
    confidence: 0.8
    evidence:
      - quote: No vacancies in finance or administration at the moment
        source_url: https://maasverhoeven.example/careers
        raw_ref: raw/2026-10/b2c3d4e5f6a1.md
    rationale: No AP roles open.
  - id: warm_path
    level: 0
    confidence: 0.6
    evidence:
      - quote: no matches for this account
        source_url: import:team
    rationale: No team connections.
  - id: persona_reachable
    level: 1
    confidence: 0.8
    evidence:
      - quote: Finance director Sofie Claes said
        source_url: https://news.example/maas-verhoeven-acquires-delcourt
        raw_ref: raw/2026-10/c3d4e5f6a1b2.md
    rationale: Name only.
---

# maasverhoeven.example — ap-automation-midmarket (full score v1)

**Total 57** · upside 70.8 · coverage 78% · tier **B** · needs check: no_ap_tool

| Factor | Group | Level | Conf. | Evidence |
|---|---|---|---|---|
| Headcount in range | fit | 3 — 150-700 | 0.9 | "with approximately 310 employees" (https://maasverhoeven.example/about) |
| Invoice-heavy industry | fit | 3 — Wholesale, distribution, manufacturing or logistics | 0.9 | "family-owned B2B food wholesaler" (https://maasverhoeven.example/about) |
| Compatible mid-market ERP | fit | unknown | 0 | — |
| No AP automation yet | fit | unknown | 0 | — |
| Finance leadership or system change | intent | 3 — Change in last 6 months | 0.9 | "has acquired Delcourt Traiteur in Liège" (https://news.example/maas-verhoeven-acquires-delcourt) |
| Hiring AP clerks | intent | 0 — No | 0.8 | "No vacancies in finance or administration at the moment" (https://maasverhoeven.example/careers) |
| Warm path to a persona | access | 0 — No connections | 0.6 | "no matches for this account" (import:team) |
| Named persona identified | access | 1 — Name only | 0.8 | "Finance director Sofie Claes said" (https://news.example/maas-verhoeven-acquires-delcourt) |

- **Headcount in range:** 310 is inside 150–700.
- **Invoice-heavy industry:** Wholesale is a top-anchor industry.
- **Compatible mid-market ERP:** No source on the ERP.
- **No AP automation yet:** No evidence either way.
- **Finance leadership or system change:** Acquisition within 6 months.
- **Hiring AP clerks:** No AP roles open.
- **Warm path to a persona:** No team connections.
- **Named persona identified:** Name only.
