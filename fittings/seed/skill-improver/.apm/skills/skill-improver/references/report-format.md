# Morning report format

Write `state/reports/<YYYY-MM-DD>.md`. This is the human review surface — it must let the operator see, in one read, exactly what changed and how to undo any of it. Always write it, even on a no-op night.

```markdown
# skill-improver — <date>

Scanned <N> sessions (<window>h). Candidates: <C>. Edits applied: <E>. Flagged: <F>.

## Edits applied (auto, revertible)
### <skill-name>  ·  <real path>  ·  repo: <committed sha | NO REPO (snapshot is the only revert) | PLUGIN — clobbered on update>
- **Feedback:** "<redacted user quote>"  (session <id>, <date>)
- **Change:** <one line: what prose changed and why it addresses the feedback>
- **Revert:** `node ~/.claude/skills/skill-improver/scripts/snapshot.mjs revert "<backup path>"`

## Flagged for you (NOT auto-applied)
### <skill-name> — code bug
- **Feedback:** "<redacted quote>"  (session <id>)
- **Diagnosis:** <what's wrong, which file/function, why it can't be auto-fixed>
- **Suggested fix:** <concrete, for when you/an agent can run + verify>

### <skill-name> — would weaken a gate / frontmatter / risky
- **Feedback:** "<quote>"  → **Why flagged, not applied:** <which rail>

## Processed sessions
<ids appended to ledger>
```

Keep edits and flags skimmable: one block each, the revert command always present, secrets always redacted. If nothing qualified, say so plainly ("No actionable skill feedback found.").
