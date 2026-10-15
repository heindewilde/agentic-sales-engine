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

| | baseline (v0.10) | optimized | change |
|---|---|---|---|
| light enrichment per account | $0.011 | $0.002 | −84% |
| deep research + full score per account | $0.753 | $0.229 | −70% |
| data providers (whole run) | $0.235 | $0.092 | −61% |
| **total pipeline** | **$1.85** | **$0.57** | **−69%** |
| citation_faithfulness | 0.96 | 1.00 | |
| brief_grounding | 0.49 | 0.85 | |
| snapshot_coverage | 0.97 | 0.92 | LinkedIn profile citations (fixed after: per-person snapshots) |
| handoff_completeness | 0.98 | 1.00 | |
| claim_support | 0.50 | 0.60 | |
| judge_stability | 0.75 | 0.88 | |

What changed: one `ase context` call instead of per-file reads; one validated `ase apply` instead of re-typing files
(light: 6 turns for 10 accounts); focused page excerpts; rule-based scoring of numeric factors; no nested research
agent and 2 accounts per research session; Haiku for discover and ways-in; terse unattended replies.
