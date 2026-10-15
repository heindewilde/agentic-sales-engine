# Cost/quality benchmark

A fixed, repeatable workload to compare engine changes on **cost per account** while holding **quality** constant.

- 10 real Benelux wholesalers (`seeds.csv`) are light-enriched and light-scored in one batch.
- 2 fixed accounts (`boma.eu`, `vanegmond.nl`) are approved and deep-researched (research + full score).
- Both eval suites run on the result (offline + Claude-as-judge on the 2 researched accounts).

```bash
bun bench/run.ts --label baseline        # ~$2–3 with live providers; results in bench/results/<label>.json
bun bench/run.ts --compare baseline,optimized
bun bench/run.ts --label my-change --push   # also send the scores to Langfuse/LangSmith as experiment "my-change"
```

Requires provider keys (`ase keys status`) and a Claude login. Costs are API-equivalent (Agent SDK `total_cost_usd`).

## Results

| | baseline (v0.10) | optimized | quality (now) |
|---|---|---|---|
| light enrichment per account | $0.011 | $0.002 | $0.002 |
| deep research + full score per account | $0.753 | $0.229 | $0.245 |
| second opinion per account | — | — | $0.029 |
| citation_faithfulness | 0.96 | 1.00 | 1.00 |
| brief_grounding | 0.49 | 0.85 | 0.97 |
| snapshot_coverage | 0.97 | 0.92 | 1.00 |
| handoff_completeness | 0.98 | 1.00 | 1.00 |
| claim_support | 0.50 | 0.60 | 0.71 * |
| judge_stability | 0.75 | 0.88 | 0.91–0.93 |

Costs are API-equivalent (on a Claude subscription only the data providers are paid). "quality" researches 5 accounts
(earlier runs: 2), so light-vs-full agreement can be measured; with 5 accounts it is still too noisy to read (τ 0.22).
\* claim_support re-run after the evaluator stopped counting reported absences ("not found since …") as unsupported;
the remaining gaps are small details added beyond the source, the next quality target.
