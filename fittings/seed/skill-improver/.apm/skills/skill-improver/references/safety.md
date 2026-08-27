# Safety rails

This skill edits OTHER skills, unattended, with auto-apply. The rails below are not optional and hold regardless of apply-mode. When two rails conflict, choose the more conservative (flag over edit).

## 1. Snapshot before edit — refuse without a revert path
Always `snapshot.mjs backup <realfile>` before editing. If it does not return `ok:true`, DO NOT edit — an auto-applied change with no revert is the one thing the design forbids. The snapshot (not git) is the universal revert net, because skills live in mixed homes.

## 2. Resolve the skill's real home before touching it
`~/.claude/skills/<name>` is often a SYMLINK. Steps:
1. `real=$(realpath ~/.claude/skills/<name>)` — edit the real file, never the link.
2. `repo=$(git -C "$(dirname "$real")" rev-parse --show-toplevel 2>/dev/null)` — if set, commit there after editing (native diff). If empty, there is no repo: the snapshot is the only revert net; state that in the report. Do NOT `git init` someone's project autonomously.
3. If the real path is under a plugins/marketplace dir, the edit will be **clobbered on update** — still allowed, but warn in the report.

## 3. Gates are sacred
Never edit that relaxes, removes, or weakens a skill's gate, guarantee, definition-of-done, safety rule, or refusal. If feedback seems to ask for that ("stop making me wait for the test"), the fix is a better technique to PASS the gate, or a flag for human review — never removing the gate. A frustrated comment is not licence.

## 4. Code is flagged, not patched
Prose/instructions/flow/wording/docs → may auto-edit. Scripts/code (selectors, math, logic, anything whose correctness needs a run) → FLAG with a diagnosis. You cannot verify a code fix unattended, and an unverified code "fix" can break a working skill.

## 5. Never touch frontmatter automatically
`name`, `description`, `disable-model-invocation`, `allowed-tools` change triggering/permissions. Flag, never auto-edit.

## 6. Minimal, on-target edits
Address exactly the feedback. No refactors, no drive-by rewrites, no style changes. Match the skill's existing voice. One feedback item → the smallest edit that resolves it.

## 7. Redact secrets
Before quoting any transcript snippet into a report/log, redact `sk-*`, `sk-ant-*`, `ghp_*`, `xoxb-*`, `xoxp-*`, and obvious bearer tokens.

## 8. Idempotent via ledger
Record every processed session (`sessionId` + `mtime`) in `state/ledger.json`. Never re-act on the same feedback twice; re-process only if the session grew (mtime changed).

## 9. Self-check each applied edit
After editing: does it (a) address the feedback, (b) leave every gate intact, (c) have a working snapshot? If any is "no", revert via the snapshot and downgrade to a flag. When in doubt, flag.

## 10. The skill vs. what it produced (the most common mistake)
Feedback about a skill's OUTPUT is not feedback about the skill. A builder skill (autothing, frontend-design) generates apps; "the app needs a side-panel button", "make it blue", "the login is broken" are about the PRODUCT, not the skill — DROP them. Only "the skill did X wrong / should do Y" about the skill's own behavior qualifies. For builder skills this is the dominant false-positive class; when a critique could be read either way, default to DROP (a missed edit is recoverable next run; editing a skill from app-feedback corrupts it).

## 11. Scope of edits
The operator set "any skill it can find" — so user skills, project area-skills, and plugins are all in scope to EDIT, with the plugin-clobber caveat (rail 2). FLAGGING is always allowed for any skill. This breadth makes rails 1–9 more important, not less.
