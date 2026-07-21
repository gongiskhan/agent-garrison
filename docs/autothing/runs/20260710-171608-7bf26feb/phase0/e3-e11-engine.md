Done. Both exploration items are complete and sent to the team lead. Summary of what I found:

## E3 — the run engine after unify

**Plan output location:** `<runDir>/FLOW_PLAN.md`, where `runDir` is the absolute evidence-home path `~/.garrison/runs/<projectLabel>/<runId>/` (minted lazily on a card's first agent-list entry — `mintRunFields`, D19). Siblings: `<runDir>/evidence-index.json`, `<runDir>/slices/<sliceId>/gate-status.json`, `<runDir>/evidence/`. All resolved by `resolveArtifactRef()` in `server.mjs`.

**Phase-boundary commits:** None. Neither the engine nor any gate logic runs git — the only `child_process` use in kanban-loop is `spawnSync` registering the scheduler cron beat. Commits happen only inside the autothing phase *skills'* work. So there is no engine phase-gate commit and no fixed trailer convention today; a stability-at-review-pass commit would have to be added.

**Events for a new `stability` hook:** Cards carry an append-only capped `events[]` timeline (no separate bus/log) written via `withEvent()` + `saveCardCAS`. The exact seam for "card passes first review" is the post-verdict `moved` branch of `processCard` (engine.mjs ~L610-643), gated on `from === "review" && effectiveNext !== "implement"`. The same seam is mirrored in `advanceCardPhase` (~L811) and `processBatch` (~L1008) — all three must emit for parity.

**Batched Test beat:** `test` list is `scheduler-beat` / `beatCron:"0 */5 * * *"` / `batched:true`. `syncListBeat` registers cron `kanban-test-beat` → `node kanban.mjs --tick-list test` → `processBatch()`: group by project, one gateway session per project, per-card `<cardId> <next-list>` verdicts. Failures map back per-card to needs-attention (or loop to `implement`).

**Cards/lists:** State at `~/.garrison/kanban-loop/board.json` + `cards/<ULID>/card.json`; membership derived, never stored. D16 locked-list rule: agent (non-interactive) lists are engine-owned (reject manual PATCH/DELETE without `x-garrison-engine`). Card has `runId`/`runDir`/`project` but **no `branch` field** — branch/worktree live in `~/.garrison/sessions/state.json`.

## E11 — where preRoute is logged

`GatewayRouter.preRoute()` (gateway-routing.mjs:562) appends every decision to **`<COMPOSITION_DIR>/.garrison/decisions.jsonl`** (live: `compositions/default/.garrison/decisions.jsonl`). Per-line schema: `{at, promptDigest, taskType, tier, matchedException, role, ruleId, targetId, profile, via, runtime, provider, model, execution}` (+ `honored/honoredReason/actual` on a misroute).

The load-bearing caveat for the brief: the record is **per turn, keyed by promptDigest — no sessionId, no cardId/runId**, and it does **not** carry the work kind or phase plan (those are card fields). A question generator can't key it by session directly; it must correlate by digest/timestamp, and read work-kind/phase-plan off the card.
