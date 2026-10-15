---
slug: ap-automation-midmarket
name: Mid-market companies drowning in supplier invoices (Benelux & DACH)
status: approved
version: 1
approved_by: hein
approved_at: 2026-10-02
offering: AP automation with ERP sync
geographies: [BE, NL, LU, DE, AT, CH]
firmographics:
  industries: [wholesale & distribution, manufacturing, logistics]
  employees: "100-1000"
  invoice_volume: ">1,500 supplier invoices / month"
technographics:
  uses: [SAP Business One, Microsoft Dynamics, Exact, DATEV]
  lacks: [AP automation tool]
triggers: [new CFO or finance director, ERP migration, acquisition, finance team hiring for AP clerks]
personas:
  - name: Finance leader
    titles: [CFO, Finance Director, Head of Finance]
    role_in_deal: economic_buyer
    jobs: [fast close, cash control]
    pains: [manual invoice entry, late approvals, duplicate payments]
    gains: [fewer AP FTE, real-time liabilities view]
  - name: AP lead
    titles: [AP Manager, Head of Accounts Payable, Accounting Manager]
    role_in_deal: champion
    jobs: [process invoices on time]
    pains: [chasing approvers by email, keying invoices]
    gains: [touchless processing]
exclusions: [public sector, companies under 50 employees, existing customers, banks and insurers]
discovery_queries:
  - wholesale distribution companies in Belgium and the Netherlands with 100-1000 employees
  - mid-sized manufacturers in Germany and Austria using SAP Business One or Microsoft Dynamics
market_size: { est_accounts: 6500, method: "registry counts NACE 46/10-33/49-52 x 100-999 employees, BE+NL+LU+DE+AT+CH", verdict: ok }
evidence:
  - { value: "8 of 10 best customers are wholesale or manufacturing with 150-600 staff", source_url: "import:icps/ap-automation-midmarket/known-customers.csv", retrieved_at: 2026-10-01, confidence: 0.9, method: import }
---
# Mid-market companies drowning in supplier invoices

## Why this segment
Our best customers share high supplier-invoice volume, a mid-market ERP and a lean finance team.[^1]

[^1]: Customer analysis, import:icps/ap-automation-midmarket/known-customers.csv
