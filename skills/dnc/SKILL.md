---
name: dnc
description: Manage the do-not-contact list — add or remove companies (domains), email addresses or LinkedIn profiles with a reason (customer, competitor, partner, opted_out, legal), list entries, or check whether someone is blocked. Use when the user says to exclude, block, never contact, or mentions existing customers or competitors to avoid.
argument-hint: "add <domain|email|linkedin> <value> <reason> | remove <value> | list | check <value>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read
---

# Do-not-contact list

Entries in `dnc.yaml` are excluded everywhere: discovery drops them, research skips them, and the workspace
hook refuses to write account or person files for them.

- Add: `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts dnc add <domain|email|linkedin> <value> --reason <customer|competitor|partner|opted_out|legal|other> [--note "..."]`
- Remove: `... dnc remove <normalized value>` (confirm with the user first; removal is rare and should have a reason).
- List / check: `... dnc list`, `... dnc check <value>`.

When the user pastes a list (e.g. a customer export), normalize and add each entry, then report counts.
After adding a domain that already has an `accounts/<domain>/` folder, tell the user: the folder stays for history,
but the account is now frozen; offer to mark it `excluded` for every ICP.
For opt-outs of a person, also offer `/agentic-sales-engine:forget-person` when they asked to be erased, not just not contacted.
