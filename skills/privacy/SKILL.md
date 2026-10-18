---
name: privacy
description: Do-not-contact list and GDPR erasure. Block or unblock companies (domains), email addresses or LinkedIn profiles with a reason (customer, competitor, partner, opted_out, legal), list entries, or check whether someone is blocked; or forget one person — remove everything the workspace holds about them (person file, warm-intro matches, mentions in briefs and notes, raw snapshots), optionally adding them to the do-not-contact list. Use when the user says do not contact, exclude, block, never contact, unsubscribe, opt-out, remove this person, delete a person's data, GDPR, right to be forgotten, or mentions existing customers or competitors to avoid.
argument-hint: "block <domain|email|linkedin-url> [reason] | unblock <value> | check <value> | list | forget <person id | name | LinkedIn URL>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Grep, Glob
---

# Privacy

Rules: `references/rules.md` §3 (people & privacy); the basis is `LEGITIMATE-INTEREST.md` in the workspace.
`ase` below means `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts`.

## Do-not-contact (`block`, `unblock`, `check`, `list`)

Entries in `dnc.yaml` are excluded everywhere: discovery drops them, research skips them, and the workspace
hook refuses to write account or person files for them.

- `block`: `ase dnc add <domain|email|linkedin> <value> --reason <customer|competitor|partner|opted_out|legal|other> [--note "..."]`
  (pick the kind from the value's shape).
- `unblock`: `ase dnc remove <normalized value>` — confirm with the user first; removal is rare and should have a reason.
- `check` / `list`: `ase dnc check <value>`, `ase dnc list`.

When the user pastes a list (e.g. a customer export), normalize and add each entry, then report counts.
After blocking a domain that already has an `accounts/<domain>/` folder, tell the user: the folder stays for history,
but the account is now frozen; offer to mark it `excluded` for every ICP.
For opt-outs of a person, also offer `forget` when they asked to be erased, not just not contacted.

## Forget a person (`forget`)

1. Resolve the person to an id: look in `people/` (by file name, `name`, or `linkedin_url`). If several match,
   ask which one. Show the user what will be removed and confirm — erasure is irreversible.
2. Ask whether they should also go on the do-not-contact list (default yes for erasure requests, so they aren't re-discovered).
3. Run `ase forget-person <id> [--dnc]`.
   It deletes the person file, removes warm matches, redacts raw snapshots, and returns `remainingMentions`.
4. For each remaining mention in briefs, notes or lists: rewrite the sentence so the person is not identifiable
   (e.g. "their CFO" instead of the name) — keep the business fact if it is still useful and sourced; delete it otherwise.
5. Re-run the command's search (`grep` for the name and LinkedIn URL) until nothing is left, then report what was removed.
   Do not record the person's name anywhere in the report file or changelog — refer to the person id only.

Note: members' own `team/<member>/connections.csv` exports are their personal data and are not modified.
