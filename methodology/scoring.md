# Scoring: Fit × Intent × Access

The score answers one question: **where should the team spend its next hour?** It has three groups:

- **Fit** — would they be a great customer? (ICP match: size, industry, model, tech, need)
- **Intent / timing** — is now a good moment? (trigger events, hiring, change)
- **Access** — can we get in? (warm paths, reachable persona, shared context)

Default group weights 0.5 / 0.3 / 0.2. Fit dominates because timing and access change; fit rarely does.

## Factors
8–12 factors (≈5 fit, 3 intent, 2 access). Each factor has:
- a **question** a researcher could answer,
- **anchored levels 0–3** described concretely enough that two judges would agree,
- a **weight** (relative, within its group),
- `light: true` if it can be judged cheaply from a homepage + firmographics (used in the wide funnel),
- optionally a **knockout**: a *known* level ≤ threshold excludes the account (e.g. company size level 0).

Good factors **discriminate** between known good and bad customers. A factor every account scores 2 on is noise.

## Judging
An LLM judge scores one factor at a time, quoting evidence with a source. No evidence → `level: null` (unknown).
The judge never averages or guesses.

## Computing (deterministic, `ase score compute`)
- Unknown factors use `unknown_prior` (default 1 — below average, not zero; missing info is a mild negative).
- Confidence weighting: `w_eff = w × (0.5 + 0.5 × confidence)`.
- Group score = Σ(w_eff × level/3) / Σ w_eff × 100; total = Σ group_weight × group score.
- **Upside** = total if every unknown were 3 — high upside with low coverage means "research this", not "skip this".
- **Coverage** = share of weight with known levels.
- Tier: A ≥ tiers.A, B ≥ tiers.B, else C; knocked out → X. Unknown knockouts are flagged `needs_check`.

## Designing and calibrating
1. Draft factors from the ICP (its traits, triggers and personas).
2. **Back-test** on known good and bad customers: good ones should rank in the top quartile (median ≥ 75th pct),
   AUC ≥ 0.8. If not, the rubric doesn't capture what makes them good — revise anchors or add a factor.
3. **Sensitivity**: perturb each weight ±20% and drop each factor; if the ranking barely moves (Kendall τ ≈ 1) the factor
   is dead weight; if one factor alone reorders everything it dominates — reconsider its weight.
4. Version every change (`version`, `changelog`, `scoring.history/`).
5. Once outcomes accumulate (≥30 logged), `score recalibrate` proposes weights from what actually converted.
   Proposals are reviewed by a human, never applied automatically.
