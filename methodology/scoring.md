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
A verified absence (the page that would show it was read, and it isn't there) is level 0 with a `checked: true`
evidence item citing that page: "we looked, it's not there" is information, "nobody looked" is not.
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
2. **Back-test** on known good and bad customers: the median good customer should outrank ≥ 75% of all other
   scored accounts (bad + prospects), and AUC (good vs bad) ≥ 0.8. If not, the rubric doesn't capture what makes them good — revise anchors or add a factor.
3. **Sensitivity**: perturb each weight ±20% and drop each factor; if the ranking barely moves (Kendall τ ≈ 1) the factor
   is dead weight; if one factor alone reorders everything it dominates — reconsider its weight.
4. Version every change (`version`, `changelog`, `scoring.history/`).
5. Once outcomes accumulate (≥30 logged), `score recalibrate` proposes factor and group weights from what actually
   engaged (L2 logistic regression on factor levels; engaged = meeting, opportunity or won). Group weights matter: a
   decisive factor in a low-weight group can't move the ranking on its own. Proposals are reviewed by a human, never
   applied automatically. Before that threshold, `ase outcomes stats` gives an early read with 95% intervals
   (does tier A engage more than B?), and the win-loss review looks for qualitative patterns.
