# Legitimate interest assessment (template)

> Not legal advice. Teams processing personal data of people in the EU/UK should complete and keep this
> assessment (GDPR Art. 6(1)(f)), and review it when the way you prospect changes.

## 1. Purpose test
- **Interest pursued:** identifying and contacting business decision makers whose organisations are likely to benefit from <offering>.
- **Is it legitimate?** Yes — direct marketing to business contacts is recognised as a possible legitimate interest (Recital 47).

## 2. Necessity test
- We only store data needed to judge relevance and reach the right role: name, current employer, job title, business contact channel, public professional activity relevant to the offering.
- We do **not** store: private contact details, special-category data, family or health information, personal social media unrelated to work.
- Sources: public company websites, press, professional profiles via licensed providers, and our own team's connection exports (kept locally, only matches are shared).

## 3. Balancing test
- People are contacted in their professional capacity, about topics related to their role.
- Every first message identifies us and offers an easy opt-out; opt-outs go into `dnc.yaml` immediately.
- Erasure requests are executed with `/agentic-sales-engine:forget-person` (removes the person file, warm-path matches and redacts raw snapshots).
- Data is refreshed or removed when stale (`ttl_days` in `ase.config.yaml`).

## 4. Decision
- Assessed by: ____  Date: ____  Review by: ____
