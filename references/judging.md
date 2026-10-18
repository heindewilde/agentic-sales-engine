# Judging rules

How to turn evidence into factor levels, for every judge (enrich-light, research, score, the factor-judge agent).
The maths is done by code; your job is only to pick levels honestly and cite them. Where your judgements go is up to
the step that asked for them; their shape is in `output-format.md` (`judgements`).

## Digest (always loaded with `ase context`)
- Judge each factor in scope against its four anchored levels; cite the exact words (≤ 40) and the source that carries them.
- Between two adjacent levels pick the lower one, with lower confidence. The level must be the one your rationale argues for.
- No evidence → `level: null`. Checked and not there → level 0 with a `checked: true` item citing the page you checked (only a page saved by `fetch_pages`, not a WebFetch summary).
- When a level asks for specific evidence (a price, a count, a date, a named role) that the page doesn't show, a homepage's own claims ("premium", "growing fast") are not that evidence: pick the lower level.

## Procedure
For each factor in scope (`light` mode: only factors with `light: true`; `full`: all):
1. Read its `question`, the four anchored `levels` (0–3), any level `examples`, and its `evidence_hint` in
   `icps/<slug>/scoring.yaml`. Factors with an `auto` rule are computed by the engine: skip them.
2. Find evidence in what you were given: facts, the brief, signals, people, the raw snapshots they reference, and for
   **access** factors the team's warm matches. Quote the exact words (≤ 40) and cite the source that carries **that
   quote**: its URL, or `import:<workspace path>` for workspace files without their own URL. Add `raw_ref` only when
   there is one, never an empty string.
3. Pick the level whose anchor (and example) the evidence matches. For time-based anchors compute the age from today's
   date first.
4. **Absence.** Absence of a mention is not evidence of absence: `level: null`. But when level 0 describes an absence
   ("careers page checked, no such roles") **and you read the page that would show it**, judge level 0 with
   `{"quote":"careers page lists no e-commerce, marketing or content roles","source_url":"https://…/careers","raw_ref":"raw/…","checked":true}`.
   A checked absence only backs level 0. If nobody looked, it stays `null`.
5. **Confidence** follows the source scale in `rules.md` (0.9 / 0.7 / 0.5 / 0.3).
6. Re-read every judgement: the level must be the one the rationale argues for. The same evidence must always produce
   the same level; consistency matters more than cleverness.

`{"id","level": 0|1|2|3|null,"confidence","evidence":[{"quote","source_url","raw_ref"?,"checked"?}],"rationale"}`, one per factor.
