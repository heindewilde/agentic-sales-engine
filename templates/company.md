---
id: example.com                # normalized registrable domain = folder name
name: Example
aliases: []
owner: me                      # team member who owns this account
dnc: false
sources:                       # how we found it (discovery query URL, import file, ...)
  - import:imports/seeds/fair-2026.csv
facts:
  # Every fact: value + source_url (http(s) | user:<member> | import:<path>) + retrieved_at + confidence (0-1).
  # Optional: ttl_days, method (exa|firecrawl|web|import|user|llm), raw_ref (raw/ snapshot), note.
  hq_country: { value: BE, source_url: https://example.com/contact, retrieved_at: 2026-10-15, confidence: 0.9, method: firecrawl }
  employees: { value: "120", source_url: https://example.com/about, retrieved_at: 2026-10-15, confidence: 0.6, ttl_days: 180 }
  industry: { value: "Industrial packaging", source_url: https://example.com, retrieved_at: 2026-10-15, confidence: 0.8 }
icp_status:
  my-icp:
    stage: discovered          # discovered → light_scored → shortlisted → researched → scored → outreach_ready | excluded
    updated: 2026-10-15
---
Short human-readable notes. Cite claims with footnotes.[^1]

[^1]: About page, https://example.com/about (retrieved 2026-10-15)
