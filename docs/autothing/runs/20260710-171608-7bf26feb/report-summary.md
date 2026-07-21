# GARRISON-FLOW-V2 — run 20260710-171608-7bf26feb

**Verdict: completed-with-blockers.** All 9 slices passed every enabled gate. One external blocker: the cross-model Codex checkpoint cannot run (codex exec -> 401, no OpenAI credentials on this box).

## Shipped
- **Same-branch coordination**: touch-set intents, 3-grade overlap ordering, stability points, interference attribution via commit fences with Garrison-Card trailers, exclusive lockfile leases, abandonment revert (prepared, never auto-applied), and a serialize fail-safe when coordination is unavailable.
- **Worktrees removed everywhere** - same branch is the only mode.
- **The generic flow is project-agnostic**: Cortex/Ekoa residue gone, Garrison-self assumptions moved to per-project policy profiles, security review made opt-in (never ambient).
- **A ux-qa phase** absorbing the design audit, with severity thresholds and loop-back.
- **Composer controls**: overlap thresholds, lease list, per-project security flag, ux-qa threshold, and a try-it strip that explains WHY a phase is included.
- **The autonomy axis collapsed**: every task is a card, no toggle anywhere, and autothing is now garrison.
- **The Improver Probe**: one tappable question at attended task boundaries, feeding the nightly proposal queue.
- **Runtime freedom**: the PTY-everywhere rule retired, agent-sdk first-class routable, a fast target seeded.

## Gates
Built-in security review **clean**. securityWall clean on every fence. deliberate-red 4/4 caught, mutation 3/3 killed, suite 1861 green, typecheck clean. Every per-slice codexSliceReview recorded **degraded (codex-unavailable)** - never faked.

## The reviews earned their keep
Real defects found and fixed: fence index isolation (a foreign staged file could ride a card's trailer), trailer spoofing, a permanently stranded waiter, a silent pipeline bypass via stale card attach, and a cross-session probe race that dropped real answers.

## Operator follow-ups
1. Run `~/.claude/skills/garrison/hooks/prune-legacy.sh` once this session ends (it correctly refuses while this run's sentinel is live).
2. Restart the orchestrator fitting (the running server predates this run's code).
3. Codex credentials would clear the one blocker.
