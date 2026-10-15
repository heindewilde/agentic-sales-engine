---
id: jane-doe-1a2b3c            # LinkedIn slug when known
name: Jane Doe
linkedin_url: https://www.linkedin.com/in/jane-doe-1a2b3c
company: example.com           # current employer (account id)
persona: Finance leader        # ICP persona name
seniority: c_level             # c_level | vp | director | manager | ic | owner | other
lawful_basis: legitimate_interest
dnc: false
facts:
  title: { value: CFO, source_url: https://example.com/team, retrieved_at: 2026-10-15, confidence: 0.9, ttl_days: 90 }
known_by:                      # filled by connection imports
  - { member: me, via: linkedin_connections, connected_on: 2021-03-04 }
---
Business-relevant context only (role, remit, public professional activity), each with a source.
