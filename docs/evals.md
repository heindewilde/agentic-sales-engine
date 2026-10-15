# Quality evals

The engine checks its own work. Two suites, both producing OpenEvals-style results (`{ key, score, comment }`) saved to
`evals/<timestamp>-<suite>.json` in the workspace and compared with the previous run (regression = mean drop > 0.05).

| Evaluator | Suite | What it checks |
|---|---|---|
| `citation_faithfulness` | offline | every scored evidence quote is present in the raw snapshot it cites |
| `brief_grounding` | offline | brief statements carry a footnote (reported absences such as "not found after …" are exempt) |
| `snapshot_coverage` | offline | URLs cited in a brief have a stored snapshot, so claims remain verifiable |
| `handoff_completeness` | offline | stage contracts hold; open questions are answered or explicitly marked unknown |
| `draft_rules` | offline | channel length limits, at least one cited fact, no clichés, no numbers absent from the sources |
| `research_trajectory` | offline | cheap lookups precede the deep research agent; the agent doesn't dominate spend |
| `claim_support` | llm | Claude judges each cited brief statement against all of its cited sources together |
| `judge_stability` | llm | re-judging a stored full score from the same evidence gives the same factor levels |
| `draft_quality` | llm | specificity, relevance, grounding, ask, brevity, voice (1–5, normalized) |

```bash
ase eval run --text                                   # offline, free
ase eval run --suite llm --budget 1 --sample 3 --text # Claude as judge via the Agent SDK (your Claude login)
ase eval run --min 0.9                                # exit 4 if any evaluator's mean is below 0.9 (CI gate)
```

CI runs the offline suite on the golden fixture account (`fixtures/workspace-ledgerly/accounts/maasverhoeven.example`)
with `--min 1`, so a change to the engine that degrades grounding or draft hygiene fails the build.

Why not OpenEvals/AgentEvals directly: their judges must be OpenAI clients or LangChain chat models, which would mean a
separate Anthropic API key plus the LangChain dependency chain. The result shape is the same, so results can be pushed to
Langfuse or LangSmith datasets.
