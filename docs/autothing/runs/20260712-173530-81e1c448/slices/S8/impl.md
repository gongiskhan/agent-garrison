# S8 (WS8) — Improver learns four patterns from shadcn/improve

Findings doc: docs/improver/SHADCN_IMPROVE_FINDINGS.md (shadcn/improve is MIT).
Four patterns adopted; the execute-in-worktree loop + security-audit category
explicitly NOT adopted.

## The four patterns (all in fittings/seed/improver)
1. **Evidence discipline** — proposals carry `citations: [{file, line, snippet}]`
   + `confidence`, preserved by enqueue (review-queue.mjs) and surfaced on the
   Improver UI ProposalCard (ui/main.tsx). Backward compatible.
2. **Vet pass** — vetProposals (shadcn-patterns.mjs) re-reads every cited
   file:line before enqueue and DROPS a proposal whose evidence is stale, logging
   `vet: dropped <id> — evidence stale at <file>:<line>`. Wired into doRunNow.
3. **Rejection ledger** — markRejected stores a reason; the reject route accepts
   `{reason}`; the UI prompts for one; recordRejection persists to
   rejection-ledger.json; suppressRejected drops a previously-rejected finding
   (by rule+targetClass+normalized-claim signature) on later runs.
4. **Reconcile mode** — reconcile (shadcn-patterns.mjs) verifies applied / refreshes
   drifted pending / retires stale pending, printing the counts. Exposed as
   `improver.mjs reconcile` (CLI) + POST /api/reconcile.

## Acceptance (all demonstrated live — slices/S8/patterns-demo.cast)
- proposals show file:line evidence + confidence;
- a PLANTED false-positive is dropped by the vet pass (log line shown);
- a rejected finding with a reason does NOT reappear on the next run (two runs);
- reconcile runs and prints verified/refreshed/retired.

## Codex findings (all resolved)
- I2: a structurally-corrupt ledger now THROWS (never silently un-suppresses/clobbers).
- I4: citation paths are contained to repoRoot (absolute/../-escape rejected) AND
  realpath-contained (an inside→outside symlink is not read).

Boundary preserved: the Improver never edits an artifact — vet/reconcile only READ
cited locations; the only writes are the queue + the rejection ledger. Full suite
2142 green. Commits: 16e0297, 9ce7df5, 907aaf3, + the symlink fix.
Built by the LEAD after impl-s8 stalled; impl-s8 later concurred with the design.
