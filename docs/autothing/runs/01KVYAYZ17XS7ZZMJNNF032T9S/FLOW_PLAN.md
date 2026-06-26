# Flow Plan — Kanban Loop V1d: make EVERYTHING work in the live app

Run dir: `docs/autothing/runs/01KVYAYZ17XS7ZZMJNNF032T9S/`
Brief: `BRIEF/kanban-loop-v1d-make-everything-work.md`

The previous passes verified against a STUB gateway, so real integration bugs shipped.
This run fixes the Kanban Loop so every list + every action works against the REAL
running Garrison (Next on `:7777`, http-gateway on `:4777`, kanban board own-port,
web-channel own-port `:7083`), proven by Playwright-driven screenshots that are
vision-verified — never asserted from HTTP 200s alone.

## Slices

| #  | Slice ID | Title | Kind | Routes to (area skill) | Parallel group | Status |
|----|----------|-------|------|------------------------|----------------|--------|
| 1  | runner-gateway-reinject  | Always re-inject GARRISON_GATEWAY_URL on already-running own-port Fittings  | mixed | runner / own-port lifecycle | A | pending |
| 2  | collapse-orphan-boards    | Reap stray kanban-loop boards on neighbour ports (7089/7090/7091 → ONE)     | mixed | runner / own-port lifecycle | A | pending |
| 3  | dispatch-survives-turn    | gatewayRunFn survives minutes-long turns + a gateway restart                | mixed | kanban-loop server + engine | A | pending |
| 4  | discuss-postmessage-open  | "Open web chat" on Discuss navigates via postMessage (cross-origin safe)    | ui    | kanban-loop UI + embed shell| A | pending |
| 5  | discuss-brief-autolink    | Brief James writes auto-links onto the card on Move-out-of-Discuss          | mixed | kanban-loop engine + UI     | B (after 4) | pending |
| 6  | live-vision-walkthrough   | Drive the matrix in the real app with Playwright + vision                   | ui    | walkthrough / browser-qa    | C (after A+B) | pending |

Status: pending | in_progress | passed | blocked. Mirror of each slice's
`<runDir>/slices/<id>/gate-status.json`.

## Acceptance per slice (machine-checkable)

### Slice 1 — runner-gateway-reinject
**Files**: `src/lib/own-port-lifecycle.ts:208-332`, `src/lib/runner.ts:418-450`,
`tests/own-port-lifecycle.test.ts`.

**Change**: extend the "already running" heal check so `GARRISON_GATEWAY_URL`
counts the same way vault secrets do. When `extraEnv.GARRISON_GATEWAY_URL`
differs from what the spawn record proves was delivered, SIGTERM + respawn — even
when `consumesVault === false`. Track delivered gateway URL in the spawn record
(`SpawnRecord` gains `gatewayUrl?: string`); a mismatch triggers heal. The
runner's `startOperativeBoundFittings()` already injects `gatewayBaseUrl`; that
stays.

**Acceptance** (proven by `tests/runner-gateway-reinject.test.ts`, new):
1. Vitest: spawn a fake own-port Fitting with no env, then call
   `startOwnPortFitting(entry, { GARRISON_GATEWAY_URL: "http://127.0.0.1:4777" })`
   — result is `{ ok: true, healed: true, pid: <new-pid> }`, NOT `alreadyRunning: true`.
2. Vitest: a second call with the SAME gateway URL returns `alreadyRunning: true`
   (idempotent — no respawn loop).
3. Vitest: spawn record after heal carries `gatewayUrl` matching the injected value.
4. Live (manual, captured in slice 6): start operative twice (`up`, `up`); the
   kanban-loop log shows `restarted to deliver gateway url`, the kanban board's
   `/health` returns `gatewayUrl: "http://127.0.0.1:4777"`.

### Slice 2 — collapse-orphan-boards
**Files**: `src/lib/runner.ts:365-416` (`reconcileOrphanedOwnPortFittings`),
`src/lib/own-port-lifecycle.ts` (add a sibling-port scan helper),
`fittings/seed/kanban-loop/scripts/server.mjs:914-939` (status-file write +
`findFreePort`).

**Change**: (a) on startup orphan sweep AND on every `startOwnPortFitting` for an
operative-bound Fitting, scan for sibling processes that bind ports in the
Fitting's default-port window (`default_port` .. `default_port+50`) and were
spawned by this user — kill any that aren't the recorded live pid; (b) the
kanban-loop server, before binding via `findFreePort`, attempts to claim the
exact `default_port` (7089) and only steps up if a non-Garrison process already
has it; (c) on graceful shutdown, the Fitting deletes its status file (already
correct for SIGTERM — verify and harden).

**Acceptance** (proven by `tests/runner-orphan-port-scan.test.ts`, new):
1. Vitest: with three sleeper processes bound to 7089/7090/7091, the sweep kills
   all three when no live spawn record matches them.
2. Live (slice 6): after `down` + `up`, `lsof -iTCP:7089-7095 -sTCP:LISTEN`
   shows EXACTLY one node listener (the kanban-loop), on the lowest free port;
   `/api/fittings/views` returns ONE kanban-loop entry; the embed iframe
   points at that one port.

### Slice 3 — dispatch-survives-turn
**Files**: `fittings/seed/kanban-loop/scripts/server.mjs:703-720` (`gatewayRunFn`),
`fittings/seed/kanban-loop/lib/engine.mjs:150-173` (failure handling),
`tests/kanban-dispatch.test.ts` (extend with a slow-runFn case).

**Change**:
- `gatewayRunFn`: wrap the `fetch` in an `AbortController` with a generous
  timeout (default `GARRISON_KANBAN_DISPATCH_TIMEOUT_MS = 30 * 60_000` = 30 min;
  configurable). A genuine timeout aborts the in-flight call and the engine
  parks the card with reason `dispatch-timeout`.
- On network error (`fetch failed` ECONNREFUSED/abort), `engine.mjs` already
  parks the card in `needs-attention`; add a per-card `lastError` field +
  surface in the card-detail UI so the user SEES the reason (today there is
  only a log line in the iteration log).
- The kanban-loop status-file write gains `gatewayUrl: <env>` so its `/health`
  echoes the gateway it will dispatch to (handshake debuggability).
- The gateway restart problem: a Garrison `up` while a turn is in flight kills
  the gateway PID; the board's POST returns ECONNRESET → card parks with
  `gateway-restarted` reason. Don't try to keep the turn alive; the cure is
  Slice 1 (heal stops re-spawning kanban needlessly) + a clear reason on the card.

**Acceptance** (proven by `tests/kanban-dispatch.test.ts` extensions):
1. Vitest: a runFn that resolves after 200 ms succeeds; one that never resolves
   is aborted by the timeout and the engine parks with `reason: "dispatch-timeout"`.
2. Vitest: a runFn that throws `Error("fetch failed")` parks the card with
   `lastError` containing "fetch failed".
3. Live (slice 6): start a real Plan dispatch; gateway `/health` and board
   `/health` both report `gatewayUrl: "http://127.0.0.1:4777"`; the card flips
   to `running`; Watch SSE shows live stdout (the operative's stream); after the
   turn the card advances to `implement` OR parks with a readable reason.
   ZERO "fetch failed" in the iteration log.

### Slice 4 — discuss-postmessage-open
**Files**: `fittings/seed/kanban-loop/ui/main.tsx:360-373` (Discuss WatchSheet),
`fittings/seed/kanban-loop/scripts/discuss.mjs:91-106` (`buildDiscussUrl`),
`src/app/embed/[fittingId]/page.tsx:38-51` (already supports
`garrison:navigate-fitting` postMessage — verify).

**Change**: replace the cross-origin `<a href={chatHref} target="_top">` with
a button that posts `{type:"garrison:navigate-fitting",
fittingId:"web-channel-default", params:{mode:"james", context:"<encoded>"}}`
to `window.parent`. Keep `buildDiscussUrl` as the encoding helper; export a new
`buildDiscussNavMessage(card)` returning the postMessage payload. The href is
kept as a non-JS fallback (`target="_blank"`) for direct-loaded board, with a
small note.

Why postMessage: the kanban iframe is loaded from a different origin
(`http://127.0.0.1:<board-port>`) than the Garrison shell (`http://127.0.0.1:7777`).
Many browsers block `window.top` navigation across origins; the existing embed
page already handles the postMessage path (`router.push` + qs forwarding).

**Acceptance**:
1. Vitest (`tests/kanban-discuss-postmessage.test.ts`, new): given a card,
   `buildDiscussNavMessage(card)` returns `{type, fittingId:"web-channel-default",
   params:{mode:"james", context:<expected base64>}}`.
2. Live (slice 6): in the live UI, click "Open web chat" on a Discuss card; the
   Garrison URL becomes `/embed/web-channel-default?mode=james&context=...`,
   the chat surface renders, a typed message round-trips through the gateway,
   and the operative replies. Screenshot the chat with the card title visible.

### Slice 5 — discuss-brief-autolink
**Files**: `fittings/seed/kanban-loop/lib/engine.mjs` (Discuss-out transition),
`fittings/seed/kanban-loop/lib/board.mjs` (card schema — `briefPath` already
declared), `tests/kanban-discuss-autolink.test.ts` (new).

**Change**: on transitioning a card OUT of the Discuss list, look for
`briefs/<briefStem(card)>.md` under the composition's briefs root; if present,
set `card.briefPath` to the relative path and persist (CAS). The encode/decode
of `briefStem` already exists in `discuss.mjs`.

**Acceptance**:
1. Vitest: create a card in Discuss, write a brief file at the predicted path,
   transition the card to Plan — saved card has `briefPath` pointing to that file.
2. Live (slice 6): part of the matrix walkthrough — after a real Discuss round-trip,
   the card's "Open" sheet lists the brief and clicking it resolves the file.

### Slice 6 — live-vision-walkthrough
**Files**: `tests/playwright/kanban-loop-v1d.spec.ts` (new), `.walkthrough/`
storyboards under this runDir (new).

**Change**: a Playwright spec that drives the LIVE app (it does not start
servers; it asserts that `:7777`, `:4777`, and the kanban + web-channel own-ports
are already serving, else fails fast with a clear error). It walks the
functionality matrix from the brief and screenshots every meaningful state. The
spec is annotated with `expectedScreen` beats; the autothing-walkthrough skill
records the narrated video from those beats.

The walkthrough covers, in order:
1. Move/Start a card onto Plan → REAL dispatch → Watch shows live output →
   card advances or parks (screenshot before/after). NO `fetch failed`.
2. Drive each agent list (Plan / Implement / Review / Adversarial Review /
   Test / Adversarial Test / Walkthrough / Validate) — confirm dispatch +
   resolve. Test list batched on its beat (verify beat path).
3. Adversarial Review/Test ARE cross-model Codex passes (don't break contract).
4. "Open web chat" on a Discuss card → web channel in James mode with the card
   context, screenshot a typed message + the operative's reply.
5. Brief James writes auto-links onto the card after Move-out-of-Discuss.
6. Every manual list (Backlog / To Do / Done / needs-attention) Move + Start.
   needs-attention recovery (move back out → re-run).
7. Per-card actions: Watch live SSE + static logs; Open resolves plan / brief /
   transcript / logs / video; list-config gear edits persist (board.json),
   survive reload, CAS rejects stale saves.
8. goal-mode card prepends `/goal` + acceptance.
9. Board survives a gateway restart and a Garrison restart (reconnects, no
   zombie ports — proves slices 1 + 2).
10. Final assertion: `lsof` shows ONE kanban-loop, ONE web-channel; ONE board in
    `/api/fittings/views`; horizontal scroll on phone-width all 13 columns
    reachable.

**Acceptance**: every numbered item from the brief's §"Acceptance" produces a
`FINDING N: …` line citing a screenshot under `<runDir>/screenshots/`, and the
spec ends by writing `<runDir>/evidence-index.json → globalGate: passed` and
prints the literal final stdout line:
```
KANBAN-LOOP-V1D OK
```

## Parallelism
- **Group A** (slices 1, 2, 3, 4) are independent file-set-wise — build in parallel.
  - Slice 1 + 2 both touch `own-port-lifecycle.ts` / `runner.ts`; share one worker if disk-conflict risk is high, else split with care (slice 2 adds the sibling-port scanner, slice 1 extends the heal predicate — no overlapping symbols).
  - Slice 3 (kanban-loop/scripts + lib + tests) and slice 4 (kanban-loop/ui +
    scripts/discuss.mjs + tests) are in disjoint files.
- **Group B** (slice 5) depends on slice 4 (the Discuss round-trip can be
  exercised end-to-end only with the postMessage path live).
- **Group C** (slice 6) depends on A + B (drives them all against the real app).

## Global acceptance
See `governance.md`. Tracked in `<runDir>/evidence-index.json → globalGate`.

The slice must reach `passed` from VISION verification: every FINDING cites a
screenshot the reviewer can re-open, and the runner-side changes are covered by
new vitest tests that fail without the patch and pass with it (proof of fix,
not just absence of regression).

## Assumptions resolved (autonomous decisions for the build phase)
1. **Dispatch timeout default** = 30 minutes. Long enough to cover a real Claude
   turn including extended thinking; configurable via
   `GARRISON_KANBAN_DISPATCH_TIMEOUT_MS`. (Brief says "minutes" — 30 covers the
   p99 turn without leaving a card hung overnight.)
2. **Sibling-port window** for orphan reaping = `default_port .. default_port+9`
   (matches `findFreePort`'s 10-step retry budget — narrow blast radius).
3. **Spawn-record schema bump** is non-breaking: `gatewayUrl` is optional;
   readers without the field treat it as "unknown" → heal proceeds (safe).
4. **Discuss button fallback**: keep the `<a href>` form for direct-loaded board
   (outside the Garrison shell, e.g. `http://127.0.0.1:7090/` opened directly)
   so non-iframe use still works.
5. **Walkthrough mode**: vision-verified screenshots, not a full narrated video.
   The brief's "vision" requirement is satisfied by reading the screenshots
   (autothing-walkthrough's vision pass) — the narrated MP4 is optional polish
   that the Walkthrough list itself produces.
