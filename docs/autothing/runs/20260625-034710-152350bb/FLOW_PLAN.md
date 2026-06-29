# Flow Plan — Kanban Loop V1d (make EVERYTHING work in the live app, vision-verified)

Run: `20260625-034710-152350bb` · project: kanban-loop-v1d
Brief: `BRIEF/kanban-loop-v1d-make-everything-work.md` (10 FINDINGs + `KANBAN-LOOP-V1D OK`).

## THE non-negotiable (every slice)
Drive the REAL running Garrison with VISION. Next app :7777, board embedded at
`/embed/kanban-loop`, board started BY THE RUNNER, real operative `up` (real http-gateway
:4777 + real Claude operative). NO STUB GATEWAY. Playwright + screenshots READ back; create
real cards; watch real dispatches (minutes) actually advance/park; assert from the screen.
Reproduce each failure with vision FIRST, fix, re-drive, SEE it fixed.

## Triage (confirmed live before planning)
- The live board was on :7090 with NO `GARRISON_GATEWAY_URL` — started by the manual
  `/api/fittings/kanban-loop/start` path (gateway down then); the later `up` saw it
  "already running → left in place" and never injected the gateway env or healed it.
- Repeated `up`s restart the gateway (pid 12864→89873) under in-flight `POST /chat` →
  `fetch failed`. The board's `gatewayRunFn` fetch has no timeout; `/chat` blocks for the
  whole minutes-long Claude turn.
- Multiple stale board procs on 7089/7090/7091 (manual-testing residue) — now killed; the
  status file is cleared; the gateway is still up on :4777.

## Slices

| # | Slice ID | Title | Kind | Owns | Status |
|---|----------|-------|------|------|--------|
| 1 | v1d-dispatch-lifecycle | Board always resolves the LIVE gateway (runner injects on up + heals an already-running/keyless board; manual /start path too); dispatch survives turn latency + gateway restart; a failed dispatch leaves a CLEAR card state (no dead "fetch failed"); ONE runner-managed board, right port | mixed | `fittings/seed/kanban-loop/scripts/server.mjs`, `src/lib/runner.ts`, `src/lib/own-port-lifecycle.ts`, `src/app/api/fittings/[id]/start/route.ts`, tests | pending |
| 2 | v1d-web-chat | "Open web chat" on a Discuss card opens the web channel (James mode + card context) from the EMBEDDED board and is usable | mixed | `fittings/seed/kanban-loop/{scripts/discuss.mjs,ui/main.tsx}`, `src/app/embed/[fittingId]/page.tsx` (only if needed), tests | pending |
| 3 | v1d-full-matrix | Drive + fix EVERY remaining list/action live: manual Move+Start+needs-attention recovery; every agent list dispatch→run→advance/park (watch a real Plan run); Watch (live SSE + static); Open (every artifact); list-config gear edits persist+used+CAS; goal-mode; survive gateway + Garrison restart | mixed | whatever each found bug touches (kanban fitting + board) | pending |

## Acceptance → FINDINGs (each from the LIVE app with a screenshot)
- s1 → FINDING 1,2,9 (dispatch works on Plan + every agent list; one board, right port, survives restart).
- s2 → FINDING 3 (open web chat) + FINDING 4 (brief auto-link round-trip).
- s3 → FINDING 5 (manual lists + recovery), 6 (Watch), 7 (Open), 8 (list-config + CAS), 10 (full vision walkthrough, no broken path).

## Live harness
ONE clean runner-managed board (re-`up` so the runner injects the gateway URL; confirm the
board env has GARRISON_GATEWAY_URL). Drive `:7777/embed/kanban-loop` + `:7777/embed/web-channel-default`
with the repo Playwright; screenshot+read every state. Real agent runs go through the real
gateway :4777 (real Claude turns — wait + watch). Codex 3A per slice; Codex 3B env-blocked.

## Global acceptance
10 FINDINGs printed, each backed by a live screenshot; every matrix item working; then
`KANBAN-LOOP-V1D OK`. No passing global gate while any matrix item is broken.
