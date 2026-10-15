# Contributing

Thanks for helping! The engine is meant to be forked and tweaked; improvements that help everyone are welcome upstream.

## Layout
- `skills/` — one folder per skill (`SKILL.md`). Skills orchestrate; they call the `ase` CLI for anything deterministic.
- `agents/` — subagents with restricted tools (researcher, judge, linter, …).
- `src/core/` — shared TypeScript library (schemas, validation, index, ledger, scoring maths).
- `src/cli/ase.ts` — CLI used by skills. `src/hooks/` — Claude Code hooks. `src/mcp/` — provider gateway MCP server.
- `methodology/` — the sales thinking, in markdown. `templates/` — entity file templates. `workspace-template/` — new workspaces.
- `tests/` — `bun test`. `fixtures/` — a fictional workspace with recorded provider responses for offline tests.

## Rules of thumb
- Anything that must be exactly right (maths, validation, dedupe, budgets) is code with tests, not prompt instructions.
- Anything that needs judgement is a skill or agent, and must cite evidence.
- Hooks fail open on internal errors (never break a user's session) but must deny invalid knowledge-base writes.
- No new runtime dependency without a reason; hooks import only `src/core`, `yaml` and `zod`.
- Never add LinkedIn scraping or logged-in browsing of social networks.

## Checks
`bun test && bun run typecheck && claude plugin validate .` must pass.
