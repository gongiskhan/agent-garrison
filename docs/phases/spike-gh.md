# Spike 0.3 — `gh pr create --fill` round-trip

**Date:** 2026-05-16
**Conclusion:** `gh` is authenticated against the active GitHub account, has read+write authorization on `gongiskhan/agent-garrison`, and the full `git push` → `gh pr create --fill --draft` → `gh pr close --delete-branch` round-trip succeeds. Phase 2's PR-creation pathways (`src/app/api/workbench/worktrees/prs/route.ts`, `close/route.ts`) can rely on this.

## Outputs captured

`gh auth status`:

```
github.com
  ✓ Logged in to github.com account gongiskhan (keyring)
  - Active account: true
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
```

`gh repo view --json url,name,nameWithOwner,defaultBranchRef`:

```json
{
  "defaultBranchRef": {"name": "main"},
  "name": "agent-garrison",
  "nameWithOwner": "gongiskhan/agent-garrison",
  "url": "https://github.com/gongiskhan/agent-garrison"
}
```

Round-trip executed:

1. `git stash --include-untracked` (preserved in-flight changes).
2. `git checkout -b spike/gh-test`.
3. Single tracked commit adding `docs/phases/.gh-spike-marker`.
4. `git push -u origin spike/gh-test` — succeeded.
5. `gh pr create --fill --draft --base main --head spike/gh-test` →
   ```
   https://github.com/gongiskhan/agent-garrison/pull/1
   ```
6. `gh pr close 1 --delete-branch --comment "spike test, closing"` — closed PR #1 and deleted both the remote and the local branch.
7. `git stash pop` — restored the pre-spike working state.

Final `git status` matched the pre-spike state (the staged briefs and modified roadmap, plus the untracked `conversations.md` and `logs/`).

## Implication for Phase 2 & 6

- `gh pr create --fill --base <base> [--draft]` is the canonical form Garrison should use (matches `worktrees/prs/route.ts:27-35` and `close/route.ts:44-59`).
- `gh pr close <num> --delete-branch` cleans up both the remote and the local branch in one shot — useful for the `close_worktree(action="discard")` path if it ever needs to retract a draft PR rather than delete the worktree directly.
- The active account is `gongiskhan` (not `pdsmcgavin`); `gh` resolves the repo via the active account automatically. No `--repo` flag is required for in-repo invocations.
- A repository-name mismatch surfaced during this spike: the GitHub repo is `gongiskhan/agent-garrison`, not `gongiskhan/garrison`. The codebase still refers to the project as "Garrison" / "Agent Garrison" — this is purely a GitHub-name detail and does not affect anything in code; just useful to know if any docs hardcode a URL.
- Note for Phase 2: the existing `prs/route.ts` invokes `gh pr create --fill --head <branch>` without `--base`; gh infers base from the repo's default branch. That's fine for now but worth surfacing if a project ever needs a non-`main` base.
