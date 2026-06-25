# Flow Plan — Kanban Loop V1c (make it work in the live app + list config)

Run: `20260624-211029-152350bb` · project: kanban-loop-v1c
Brief: `BRIEF/kanban-loop-v1c-build-brief.md` (7 FINDINGs + final `KANBAN-LOOP-V1C OK`).

## THE non-negotiable (per slice)
Every slice is verified THROUGH the running Garrison: Next app on `127.0.0.1:7777`, the
board started BY THE RUNNER (`startOwnPortFitting` → `scripts/start.mjs`) + surfaced at
`/embed/kanban-loop`, the default operative `up` so the **http-gateway actually runs**,
driven via the repo's own Playwright against the live app (codex's sandbox can't launch
Chromium → Codex 3B is env-blocked; use Playwright + Codex 3A). "Works standalone" is NOT
acceptance.

## Live diagnosis (confirmed before planning)
- Garrison Next app runs on :7777. The board now boots via the runner (`start.mjs` added)
  and is in the Views menu serving the 13-list V1b pipeline. `data/library.json` → "Kanban
  Loop". `buildDiscussUrl` → `/embed/web-channel-default`. (V1b post-ship fixes, in tree.)
- **http-gateway is NOT running** unless the operative is `up`; the board own-port server is
  started with **no `GARRISON_GATEWAY_URL`** ("Start on agent lists is disabled"); the
  runner own-port spawn does not inject the gateway URL; `Move` (PATCH) never dispatches.
  → the run loop is dead end-to-end. (slice v1c-dispatch)
- No UI to configure a list's skill/prompts/validNext/trigger/mode. (slice v1c-list-config)
- The brief James writes in Discuss is not auto-linked onto the card. (slice v1c-discuss)

## Slices

| # | Slice ID | Title | Kind | Area / owns | Group | Status |
|---|----------|-------|------|-------------|-------|--------|
| 1 | v1c-dispatch-wiring | Board + tick wired to the gateway; landing on an immediate agent list dispatches a real run | mixed | `fittings/seed/kanban-loop/{scripts/server.mjs,scripts/kanban.mjs}`, `src/lib/runner.ts`, `tests/kanban-dispatch.test.ts` | P0 | passed |
| 2 | v1c-list-config-ui | View + edit a list's config in the board UI, persisted atomically to board.json | ui | `fittings/seed/kanban-loop/{scripts/server.mjs,ui/**,lib/board.mjs}`, `tests/kanban-list-config.test.ts` | P1 (after 1) | passed |
| 3 | v1c-discuss-roundtrip | Discuss → web chat (James) → brief auto-linked onto card.briefPath | mixed | `fittings/seed/kanban-loop/{scripts/discuss.mjs,scripts/server.mjs}`, web-channel brief-save hook, `tests/*` | P1 (after 1) | passed |
| 4 | v1c-live-regressions | Confirm the V1b post-ship fixes live (board boots via runner + Views; library label; web-chat id) | mixed | verification + `tests/own-port-start.test.ts` (kept) | P2 | passed |

## Acceptance per slice
- **v1c-dispatch-wiring** [FINDING 1,2]: the board server defaults `GARRISON_GATEWAY_URL` to `http://127.0.0.1:4777` (like the web channel) and the runner injects the live gateway URL into the operative-bound own-port spawn env; the scheduler `kanban-tick` likewise. Landing a card on an immediate agent list (Plan) dispatches a real `autothing-plan` run through the gateway — implemented as Move-onto-an-immediate-agent-list auto-dispatching AND/OR a Start that works. Verified LIVE: operative `up` (gateway running) → move/start a card into Plan → the card mints a runId and advances (or parks with a visible reason), driven from the embedded UI.
- **v1c-list-config-ui** [FINDING 5]: a board surface views + edits each list's skill / execute-prompt / router-prompt / validNext / trigger / mode / classification; saves persist to `board.json` via read-fresh→mutate→write-whole (atomic), validated (skill non-empty, validNext ⊆ real list ids, no traversal); manual lists carry no agent config. Verified LIVE: edit a list in the running board, reload, confirm persisted + the engine uses it.
- **v1c-discuss-roundtrip** [FINDING 3,4]: "Open web chat" in the embedded board opens the web channel in James mode with the card context; the brief James writes under `briefs_path` is linked onto `card.briefPath` without a manual step (wire the save → `POST /cards/:id/brief`, or the engine detecting the brief). Verified LIVE end-to-end.
- **v1c-live-regressions** [FINDING 6,7]: board started by the runner is in the Views menu serving the V1b pipeline; `/api/library` shows "Kanban Loop"; `buildDiscussUrl` → web-channel-default. Regression `tests/own-port-start.test.ts` green.

## Live verification harness
Stand up the default operative (`POST /api/runner/default/up` or the runner CLI) so the gateway runs; confirm the board has the gateway URL; drive the embedded board (`:7777/embed/kanban-loop`) + the web channel (`:7777/embed/web-channel-default`) with the repo Playwright (chromium launches outside the codex sandbox). Every FINDING is proven from this live stack.

## Global acceptance
7 FINDINGs printed (each from the live app) + `KANBAN-LOOP-V1C OK`. Codex 3A approve per slice; Codex 3B env-blocked (documented); videos = live Playwright walkthroughs.
