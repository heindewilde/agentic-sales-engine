---
name: forget-person
description: GDPR erasure — remove everything the workspace holds about one person (person file, warm-intro matches, mentions in briefs and notes, raw snapshots) and optionally add them to the do-not-contact list. Use when someone asks to be forgotten or removed, or the user asks to delete a person's data.
argument-hint: "<person id | name | LinkedIn URL>"
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts *), Read, Edit, Grep, Glob
---

# Forget a person

1. Resolve `$ARGUMENTS` to a person id: look in `people/` (by file name, `name`, or `linkedin_url`). If several match,
   ask which one. Show the user what will be removed and confirm — erasure is irreversible.
2. Ask whether they should also go on the do-not-contact list (default yes for erasure requests, so they aren't re-discovered).
3. Run `bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ase.ts forget-person <id> [--dnc]`.
   It deletes the person file, removes warm matches, redacts raw snapshots, and returns `remainingMentions`.
4. For each remaining mention in briefs, notes or lists: rewrite the sentence so the person is not identifiable
   (e.g. "their CFO" instead of the name) — keep the business fact if it is still useful and sourced; delete it otherwise.
5. Re-run the command's search (`grep` for the name and LinkedIn URL) until nothing is left, then report what was removed.
   Do not record the person's name anywhere in the report file or changelog — refer to the person id only.
Note: members' own `team/<member>/connections.csv` exports are their personal data and are not modified.
