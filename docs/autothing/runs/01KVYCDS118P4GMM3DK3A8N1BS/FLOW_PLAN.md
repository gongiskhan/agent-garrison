# FLOW_PLAN — Kanban Loop V1d: make EVERYTHING work in the live app

**Run:** `docs/autothing/runs/01KVYCDS118P4GMM3DK3A8N1BS`
**Brief:** `BRIEF/kanban-loop-v1d-make-everything-work.md`
**Mode:** live integration (real Next on `127.0.0.1:7777`, real http-gateway on `:4777`, real operative, real own-port board started BY THE RUNNER) — no stub gateway anywhere, vision-verified.
**Note:** re-plan of the same brief as run `01KVYC0S4AWS3VB36J53F5MGX3` (released ~10 min ago, same code state). Same root-cause map; this run gets its own per-run artifacts.

## Problem (verified against the code map)

1. **`fetch failed` on Move-to-Plan.** Compounding root causes:
   - `src/lib/own-port-lifecycle.ts:243–250` returns `alreadyRunning:true` and **skips env re-injection**; healing (`:248`) only fires for vault-consuming fittings with `!secretsDelivered`, so a kanban-loop board left running without `GARRISON_GATEWAY_URL` is never repaired.
   - `src/lib/runner.ts:425–435` only injects `GARRISON_GATEWAY_URL` when `record.gateway.baseUrl` exists at start time; nothing reconciles drift if the gateway restarts later.
   - `fittings/seed/kanban-loop/lib/gateway-client.mjs:33–47` `gatewayRunFn` has **no client-side fetch timeout** and `/chat/stream` is a multi-minute synchronous turn; if the gateway is restarted under it, the fetch can hang or surface only as a raw `fetch failed`.
   - `fittings/seed/kanban-loop/scripts/server.mjs:603–614` `handlePatchCard` fires `processCard` without `await`, catches errors **to console only**; the card UI shows no state change → user sees nothing on the card and only `fetch failed` in devtools.
   - Multiple boards on `7089/7090/7091` indicate respawn-on-port-collision instead of strict single-board reuse.
2. **Discuss → Open web chat does nothing.** `fittings/seed/kanban-loop/scripts/discuss.mjs:91–106` hardcodes `webChannelBase = "/embed/web-channel-default"`; if the composition's channel fitting id differs, or `/embed/<id>` cannot resolve, the link silently navigates to a 404 with no error surface. The card-side brief-link-back on Move-out-of-Discuss is also unverified.
3. Misc surface gaps: `/cards/:id/artifact` link rendering, list-config CAS round-trip, watch-stream live vs static, scheduler-beat path for Test, gateway-restart survival.

## Out of scope (per brief)

- Web channel staying generic (don't teach it kanban).
- Operative test interface.
- Web channel's own design.

## Slices

Build in order. Each slice is committed-and-verifiable on its own.

| # | Slice | Scope | Critical files |
|---|---|---|---|
| S1 | Single runner-managed board + env-drift healing for own-port fittings | runner reconciles `GARRISON_GATEWAY_URL` on every `up`; if an own-port fitting is already running but its delivered env differs from the desired env (different gateway URL, or missing), restart it (snapshot spawn-record). Status file is the only source of truth for the board's port; collapse stray boards. | `src/lib/own-port-lifecycle.ts`, `src/lib/runner.ts`, `fittings/seed/kanban-loop/scripts/start.mjs` |
| S2 | Dispatch robustness + visible failure | board pre-flight checks `GARRISON_GATEWAY_URL` reachability on dispatch; `gatewayRunFn` adds a bounded client-side fetch timeout that **exceeds** a real Plan turn (default ≥ 15 min, configurable); on transport failure the engine sets a card status (`gateway-unavailable`) AND a one-line `card.lastDispatchError` persisted via `saveCardCAS`; UI shows a red badge + readable reason; auto-dispatch surfaces the error in the patch response. | `fittings/seed/kanban-loop/lib/gateway-client.mjs`, `fittings/seed/kanban-loop/lib/engine.mjs`, `fittings/seed/kanban-loop/scripts/server.mjs`, `fittings/seed/kanban-loop/lib/board.mjs`, `fittings/seed/kanban-loop/ui/main.tsx` |
| S3 | Discuss → Open web chat works + brief auto-links back | `buildDiscussUrl` resolves the channel embed id from a runtime lookup (status file on the board side, baked into the page via a `/board/runtime` endpoint or `window.__GARRISON__` injected by the embed route); if no channel is reachable, surface a clear "no web channel installed" instead of silently linking to a dead route. James-mode + card-context handoff stays as base64 opaque context. On move out of Discuss, the card's `briefPath` is auto-resolved from `briefRelPath()` if a brief file exists at that path. | `fittings/seed/kanban-loop/scripts/discuss.mjs`, `fittings/seed/kanban-loop/scripts/server.mjs`, `fittings/seed/kanban-loop/ui/main.tsx`, `fittings/seed/kanban-loop/lib/engine.mjs` |
| S4 | Live vision verification (matrix) | A Playwright spec that requires the real composition (`up default` already done — no spawn), drives `127.0.0.1:7777/embed/kanban-loop`, exercises every list and action from the brief's matrix, screenshots every meaningful state to `docs/autothing/runs/01KVYCDS118P4GMM3DK3A8N1BS/vision/<NN>-<slug>.png`, watches a real Plan run end-to-end (≥ 15 min budget), and writes a numbered `FINDINGS.md` next to the screenshots. Each FINDING line cites a screenshot file. The spec is run with vision review (the operative reads each saved PNG before declaring the FINDING passed). | `tests/e2e/kanban-loop-v1d.spec.ts` (new), `playwright.config.ts` (add project with longer timeout), `docs/autothing/runs/01KVYCDS118P4GMM3DK3A8N1BS/vision/`, `FINDINGS.md` |

## Detailed slice notes (just enough — build phase fills in)

### S1 — single board + env healing

- **Own-port-lifecycle**: add a `desiredEnvFingerprint` (sha of the keys we care about: `GARRISON_GATEWAY_URL`, plus any other lifecycle-managed env) to the spawn record. On `startOwnPortFittingLocked`, if `alreadyRunning && deliveredEnvFingerprint !== desired`, treat as a heal — kill the existing PID, respawn with the right env. Don't widen the heal trigger past what's necessary (still no-op when the env matches).
- **Runner**: when no gateway fitting exists, `GARRISON_GATEWAY_URL` is intentionally absent → board's `Start on agent lists is disabled` path is fine, but we must also persist a clear `noGateway` flag in the status file so the UI can render an explicit "no gateway available" instead of a silent failure.
- **Single board**: if the status file `~/.garrison/ui-fittings/kanban-loop.json` points at a live PID on a known port, never spawn a new board on a different port; orphan-clean any other PIDs spawned by previous runs of this fitting. Use the existing `provenance.ts` + orphan-clean machinery; do not invent new tracking.

### S2 — dispatch robustness

- **gateway-client.mjs**: accept `fetchTimeoutMs` (default `gatewayHints.timeoutMs + 60_000`); abort the fetch with a `transport: true` error on timeout; same `transport: true` on network errors. Keep the existing 502/503/504 handling.
- **engine.mjs `processCard`**: when `err.transport`, set card status to `gateway-unavailable` (new badge), set `card.lastDispatchError = { at, reason, listId }` via `saveCardCAS`, KEEP the card on its current list (do not park) so the user can retry — matches the brief's "leave card in a CLEAR state". For non-transport errors, the existing park-to-needs-attention with a readable reason stays.
- **server.mjs `handlePatchCard`**: pre-flight `gatewayReachable()` before auto-dispatch; if unreachable, respond `{ dispatched: false, reason: "gateway-unavailable" }`, set the card badge inline, still let the patch (move) succeed. Stop swallowing fire-and-forget errors — wire processCard's outcome back into the card via the new `lastDispatchError` mechanism.
- **UI**: a red badge + tooltip on cards whose status is `gateway-unavailable`, with `lastDispatchError.reason` in the tooltip; a "Retry dispatch" button calls `POST /cards/:id/start`. Plain CSS, no emoji per project rules.

### S3 — Discuss handoff + brief link-back

- **Runtime channel discovery**: server exposes `GET /board/runtime` returning `{ webChannelEmbedId, webChannelUrl, gatewayBaseUrl, noGateway }`. The UI fetches `/board/runtime` on mount; `buildDiscussUrl` uses `webChannelEmbedId` instead of the hardcoded `web-channel-default`. If no channel is reachable, the WatchSheet for interactive lists shows "no web channel installed" instead of a dead `<a>`.
- **Brief link-back**: `engine.mjs` on Move-out-of-Discuss checks `fs.existsSync(briefRelPath(card))`; if present, set `card.briefPath` via `saveCardCAS`. No deep integration with the channel — purely a file-system check.

### S4 — Live vision verification

The spec assumes the operative ran `npm start` + brought `default` up beforehand. Inside the spec:

1. Wait for `127.0.0.1:7777` + `127.0.0.1:4777/health` + the kanban-loop status file with a reachable port.
2. Create a fresh project, create cards seeded for each list, drive Move/Start, take screenshots after each meaningful state with `page.screenshot({ path: ".../vision/<NN>-<slug>.png", fullPage: true })`.
3. For Plan: trigger dispatch, then poll `/cards/:id` until status leaves `running` OR up to 25 minutes; screenshot the running state, the Watch SSE pane (with text), and the final state.
4. For Discuss: open WatchSheet, assert the link target is the resolved web-channel URL, navigate, screenshot the web chat with the card context and James mode active.
5. List-config gear: edit a field, save, reload, assert persisted; submit a stale-rev save, assert 409.
6. Restart the gateway (`bin/garrison up default --restart-gateway` or `kill $(cat …)` + `up`), confirm the board reconnects and a fresh dispatch works.
7. Write `FINDINGS.md` with the 10 numbered lines from §Acceptance, each citing its screenshot file. The build phase's final stdout line is `KANBAN-LOOP-V1D OK` only when every FINDING is OK.

## Critical files for implementation

- `src/lib/own-port-lifecycle.ts` — heal-on-env-drift, desired-env fingerprint.
- `src/lib/runner.ts` — pass+persist env fingerprint, single-board enforcement (status-file authority).
- `fittings/seed/kanban-loop/scripts/server.mjs` — `/board/runtime`, `handlePatchCard` failure semantics, `lastDispatchError`, brief auto-link on Move-out-of-Discuss.
- `fittings/seed/kanban-loop/lib/engine.mjs` — transport vs non-transport routing, `lastDispatchError`, brief link-back on Move-out-of-Discuss.
- `fittings/seed/kanban-loop/lib/gateway-client.mjs` — client-side fetch timeout.
- `fittings/seed/kanban-loop/lib/board.mjs` — add `lastDispatchError`, `status` enum extension; CAS untouched.
- `fittings/seed/kanban-loop/scripts/discuss.mjs` — runtime channel discovery; `webChannelBase` becomes a parameter, not a hardcoded constant.
- `fittings/seed/kanban-loop/ui/main.tsx` — runtime-fetch + render gateway-unavailable badge, retry button, no-channel error path on Discuss WatchSheet.
- `tests/e2e/kanban-loop-v1d.spec.ts` (NEW) — live vision matrix.
- `playwright.config.ts` — add a project / timeout for the long live spec; do not disturb existing.
- `docs/autothing/runs/01KVYCDS118P4GMM3DK3A8N1BS/vision/` (NEW dir, populated at run time).
- `docs/autothing/runs/01KVYCDS118P4GMM3DK3A8N1BS/FINDINGS.md` (NEW, written at run time).

## Decisions made autonomously (recorded so we can audit later)

- **Card stays on the source list on transport failure** instead of parking. Rationale: matches the brief's "leave in a CLEAR state", lets the user retry without manual recovery.
- **`fetchTimeoutMs` defaults to `gatewayHints.timeoutMs + 60_000`**. Rationale: gateway already enforces per-turn cap; the client just needs a safety net.
- **`/board/runtime` over build-time substitution.** Rationale: avoids regenerating the dist bundle each `up`; cheap to fetch once on mount.
- **One Playwright spec, one composition.** Rationale: keeps the verification reproducible; subagent variants risk masking drift.
- **No new capability kind, no new Faculty.** Rationale: project rule (CLAUDE.md "Don't add a new capability kind speculatively").

## Acceptance (machine-checkable; mirrors brief §Acceptance)

The build phase MUST emit `FINDINGS.md` at `docs/autothing/runs/01KVYCDS118P4GMM3DK3A8N1BS/FINDINGS.md` containing **10 numbered FINDING lines**, each ending in `OK` and citing at least one screenshot file path under `docs/autothing/runs/01KVYCDS118P4GMM3DK3A8N1BS/vision/`. The list must be exactly:

1. Move/Start onto Plan dispatches a real gateway run; the card runs (Watch shows output) and advances or parks with a readable reason — no `fetch failed`.
2. Every agent list (Plan, Implement, Review, Adversarial Review, Test, Adversarial Test, Walkthrough, Validate) dispatches + resolves correctly on entry.
3. Discuss "Open web chat" opens the web channel in James mode with the card context and is usable.
4. Discuss brief auto-links onto the card after the round-trip.
5. Every manual list's Move + Start works; needs-attention recovery works.
6. Watch shows live output for a running card and static logs otherwise.
7. Open resolves+opens each existing artifact (plan, brief, transcript, logs, video).
8. List-config edits persist + are used; CAS rejects stale saves (409).
9. ONE runner-managed board with the correct port; survives gateway + Garrison restart.
10. A full vision walkthrough (screenshots) of the above exists; no broken path remains.

After `FINDINGS.md` is written and every FINDING is `OK`, the run prints the literal final stdout line:

```
KANBAN-LOOP-V1D OK
```

This sentinel is the build phase's success gate.

## Risks / open notes

- A real Plan turn can take many minutes; the spec budgets 25 minutes per dispatched card and screenshots progress every 60s so we have evidence even if a run hangs.
- Restarting the gateway mid-spec is the only step that can affect other in-flight sessions on the host; the spec runs against the `default` composition the user has open, so the user must accept a brief gateway restart during verification.
- If `/board/runtime` injection conflicts with the existing dist build, fallback path: the board UI fetches `/board/runtime` on mount and renders the WatchSheet only after it resolves.
