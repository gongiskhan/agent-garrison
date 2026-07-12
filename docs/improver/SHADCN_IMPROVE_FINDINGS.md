# shadcn/improve — patterns adopted into the Garrison Improver (WS8 / D10)

Source: [shadcn/improve](https://github.com/shadcn/improve) (MIT, verified). It is
an agent skill that audits a codebase and writes implementation PLANS for cheaper
agents to execute — "the plan is the product; the skill never implements
anything itself." That propose-then-execute split is the same boundary the
Garrison Improver already enforces (propose-then-APPROVE; the Improver never
edits artifacts). We adopt four of its discipline patterns and explicitly skip
two.

## The patterns and how each maps onto Garrison's Improver

### 1. Evidence discipline (adopted)
shadcn/improve: *"A finding is only a finding with evidence. 'Probably has N+1
queries somewhere' is not a finding; `orders/api.ts:142 issues one query per
order item inside a loop` is."* Every finding carries `file:line` evidence,
impact, effort, and **Confidence: HIGH / MED / LOW**.

Garrison mapping: proposals now carry `evidence: [{file, line, snippet?}]` +
`confidence: "high"|"medium"|"low"`, threaded through `enqueue` (was dropping
non-whitelisted fields) and surfaced on the Improver UI ProposalCard. Backward
compatible — a proposal with no evidence still loads.

### 2. Vet pass (adopted)
shadcn/improve: *"Subagents over-report, so the advisor re-reads every cited
location itself before showing you anything — false positives get dropped, wrong
attributions get corrected."*

Garrison mapping: `vetProposals(proposals)` re-reads every cited `file:line`
before enqueue and DROPS a proposal whose evidence no longer holds (the cited
line is gone, or doesn't contain the claimed snippet), logging
`vet: dropped <id> — evidence stale at <file>:<line>`.

### 3. Rejection ledger (adopted)
shadcn/improve: *"…and rejected a few, with reasons recorded so they don't come
back next run."*

Garrison mapping: a reject now STORES a reason (`markRejected(queue, id, at,
reason)` + the `/api/proposals/:id/reject` body + the UI reject prompt),
persisted to `~/.garrison/improver/rejection-ledger.json`. On later runs, a
proposal whose signature (rule + targetClass + normalized claim) matches a prior
rejection is SUPPRESSED — not re-enqueued.

### 4. Reconcile rule (adopted)
shadcn/improve: *"`reconcile` — verifies DONE plans still hold, refreshes drifted
plans, retires findings that got fixed independently."*

Garrison mapping: `reconcile(queue)` VERIFIES applied proposals still hold
(re-vet their evidence), REFRESHES drifted pending ones, and RETIRES stale
pending ones (evidence gone, or pending past a TTL). Prints
`{verified, refreshed, retired}` counts. Built on the existing reapply-sweep /
ecosystem reconcile base — extended, not replaced.

## Explicitly NOT adopted (per D10)
- **The execute-in-worktree loop.** shadcn/improve dispatches a cheaper executor
  in an isolated git WORKTREE and reviews the diff. Garrison bans worktrees and
  the Improver never executes — it only proposes. Skipped entirely.
- **The security-audit category.** Out of scope for this run (the security /
  prompt-injection validators are deferred). Skipped.
