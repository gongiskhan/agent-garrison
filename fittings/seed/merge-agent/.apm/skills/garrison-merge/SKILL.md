---
name: garrison-merge
description: Merge another Garrison node's branch into this node's checkout of a project, under the two rails - a pre-merge revert tag and a decision card for every non-trivial merge. Use when a merge card arrives on this node's board (duty `merge`), when a node's work needs to land here, or when the nightly convergence card asks for a merge. Not for ordinary same-branch commits and not for resolving a conflict a human is already sitting in.
---

# Merging another node's work

Garrison merges across nodes **autonomously**. That only works because two rails
make every merge reversible and visible. Do not skip either one, and do not
"simplify" a merge by taking one side wholesale.

## The two rails

**Rail 1 - the pre-merge tag.** Before any non-trivial merge, tag the current
HEAD:

```
git tag garrison/premerge/<project>/<thisNode>/<stamp>
```

`<stamp>` is the ISO instant with the colons removed (`2026-08-24T191134Z`) - a
git ref may not contain `:`. Use `premergeTag()` from `lib/merge.mjs` rather than
building the string by hand.

The tag is the revert. If anything is wrong afterwards:

```
git reset --hard garrison/premerge/<project>/<thisNode>/<stamp>
```

A tag, not a branch: it stays out of `git branch`, is not auto-pruned, and pushes
once. The nightly convergence card prunes tags older than 14 days.

**Rail 2 - the decision card.** Every **non-trivial** merge files a card on
`needs-attention` carrying the pre-merge tag, both shas, the conflict list, and
the chosen resolution for each conflict. A **trivial fast-forward files
nothing** - a board full of "merged 3 commits, no conflicts" stops being read,
and a rail nobody reads is not a rail.

## Procedure

1. **Read the card.** It names the project, the source node, the source branch
   and the source sha. Resolve the project to this node's checkout under the
   dev-root. If the project does not exist here, file a needs-attention card and
   stop - do not clone it.

2. **Refuse to merge under a live agent.** If a session is running with this
   repository as its cwd, stop and say so. Merging under an agent's feet commits
   half-written files.

3. **Fetch.** `git fetch --all --prune`. This is the only network call you need
   before deciding anything.

4. **Decide whether it is trivial.** `isTrivialFastForward(cwd, "origin/<branch>")`.
   If it is, fast-forward, push, and file **nothing**. You are done.

5. **Tag.** `git tag garrison/premerge/<project>/<node>/<stamp>` at the current
   HEAD, before the merge command runs.

6. **Merge.** `git merge --no-ff origin/<sourceBranch>`.

   **Never `-X ours` or `-X theirs`.** Ever. A blanket strategy option is how you
   silently lose a day of someone else's work, and it is invisible in the
   resulting diff.

7. **Handle conflicts file by file.** For each conflicting path, read **both
   sides in full** (`git show :2:<path>` and `git show :3:<path>`) plus the merge
   base (`git show :1:<path>`). Produce a resolution that keeps both intentions.
   Then **prove the result parses** - run the language's cheapest syntax check
   (`node --check`, `tsc --noEmit` on the file's project, `python -m py_compile`,
   `yaml`/`json` parse). A conflict resolution that does not parse is not a
   resolution.

8. **Refuse what must not be merged.** Run `refusalList(conflictPaths)`. Anything
   it returns stops the merge:

   - **Lockfiles** (`package-lock.json`, `apm.lock.yaml`, `yarn.lock`,
     `pnpm-lock.yaml`, `Cargo.lock`, `uv.lock`, `go.sum`, …) are **regenerated**,
     never merged. A three-way-merged lockfile is valid syntax describing a
     dependency tree that has never existed. Take one side, then re-run the
     installer to regenerate.
   - **Binaries** have no line structure. Escalate.
   - **The never-travels list** (`.env`, `vault.json`, `local.yml`, `owner.json`,
     `apm_modules/`, `node_modules/`, `.claude/`) is machine-local or secret.
     Escalate; never carry one across nodes.

   Escalating means: `git merge --abort`, then a needs-attention card naming the
   paths and why. Do not guess.

9. **Verify before you commit the merge.** Run the project's fast checks - at
   minimum a typecheck and the test file(s) touching the conflicted paths. A
   merge that compiles is the floor, not the goal.

10. **Commit and push** on the current branch.

11. **File the decision card** when the merge was non-trivial: the premerge tag,
    `from` sha, `to` sha, the conflict list, and one line per resolution saying
    which side won and why. That card is the record that makes an autonomous
    merge acceptable.

## When to stop and ask

Stop, abort, and file a needs-attention card when:

- the conflict is a genuine semantic disagreement (both sides changed the same
  behaviour in incompatible ways) rather than two edits that can coexist;
- a refusal-list path conflicts;
- a resolution will not parse or the project's checks fail after the merge;
- the working tree was already dirty or a merge/rebase was already in progress.

An honest stop with a tag to reset to costs minutes. A confident wrong merge
costs a day of someone else's work, and nobody finds out until much later.
