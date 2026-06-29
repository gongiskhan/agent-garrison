# BRIEF: Kanban Loop V1c — make it actually work in the live app, + list config

## What this is

V1b built the engine, the board UI, the gateway hint, the web channel, Discuss, and
`autothing-validate`, and unit-tested + standalone-rendered all of it. But it was **never
exercised through the running Garrison**, and that hid a cluster of live-wiring bugs the
user hit immediately:

- the board didn't start under the runner (missing `scripts/start.mjs`) — **fixed**;
- the menu showed "Kanban Loop (V1a)" (stale `data/library.json` label) — **fixed**;
- "Open web chat" in Discuss did nothing (wrong embed fitting id) — **fix started**;
- **moving a card to Plan does nothing — no plan run starts** (the core loop);
- **there is no way to configure a list** (skill / execute-prompt / router-prompt /
  validNext / trigger / mode) — V1b deferred this; the user wants it.

V1c closes these and makes the Kanban Loop **drive real work end-to-end in the running
Garrison**, verified by clicking the actual UI — not a standalone server.

## THE non-negotiable (the V1b lesson)

**Every slice is verified THROUGH the running Garrison app**, not by `node server.mjs`
standalone or unit tests alone. Concretely, a slice is not done until it is exercised
against: the live Next app on `127.0.0.1:7777`, the kanban board started by the **runner**
(`startOwnPortFitting` → `scripts/start.mjs`) and surfaced at `/embed/kanban-loop`, the
**operative `up`** for the default composition (so the **http-gateway is actually
running**), and the embedded UI driven with Playwright (or the live browser). "Works
standalone" is explicitly NOT acceptance. Where a step genuinely needs the operative
(a real `claude` run), stand it up via the runner and drive it; only a real external
blocker (e.g. an interactive auth that cannot run headless) may be deferred, and only with
the failed command logged.

## Issues to fix

### 1. The run loop — moving/starting a card on an immediate agent list must dispatch
Root causes (all confirmed live): (a) the board own-port server is started with **no
`GARRISON_GATEWAY_URL`**, so it logs "Start on agent lists is disabled" and cannot
dispatch; (b) the runner's own-port spawn does not pass the gateway URL to the board;
(c) the scheduler `kanban-tick` job's env has no gateway URL either; (d) `Move` (PATCH)
only changes the card's list — it never triggers a dispatch, and the http-gateway is only
running when the operative is `up`.

Make it work: wire the board server (and the scheduler tick) to the gateway URL — default
to `http://127.0.0.1:4777` like the web channel, and let the runner inject the live
gateway URL into the operative-bound own-port spawn env. Decide and implement the trigger
so that **landing a card on an immediate agent list actually starts the run** — either
`Move` onto an immediate agent list dispatches (matching the user's expectation that
"moving to Plan starts planning"), or `Start` reliably dispatches and the board makes that
obvious; do not leave a card silently parked. **Verify live**: with the default operative
`up` (gateway running), move a card into Plan → a real `autothing-plan` run fires through
the gateway, the card mints its runId, and it advances (or parks with a visible reason).

### 2. Discuss → web chat → brief round-trip (live)
`buildDiscussUrl` now targets `/embed/web-channel-default` (the correct fitting id) — verify
that clicking **Open web chat** in the embedded board navigates Garrison to the web channel
in **James mode** with the card context. Close the loop: the brief James writes to disk
must get **linked back onto the card** (`card.briefPath`) — wire the `POST /cards/:id/brief`
path (who calls it: James/the web channel on save, or the engine detecting the brief under
`briefs_path`) so the card shows the brief link without a manual step. **Verify live** end
to end (open chat in James mode → a brief is written → the card links it → manual advance
to Plan).

### 3. List configuration in the UI
Add a way to **view and edit each list's configuration** — skill, execute-prompt,
router-prompt, validNext, trigger, mode, classification (taskType/tier) — from the board
(the legibility principle: the system is read + tuned through the UI, not only hand-edited
`board.json`). Edits persist atomically to `board.json` (read-fresh → mutate → write-whole,
the host-config IO discipline in `docs/architecture.md`); manual lists carry no agent
config. Keep it safe (validate skill names + validNext against real list ids; no traversal).
**Verify live**: edit a list's skill/prompt in the running board, reload, confirm it
persisted and the engine uses the new config on the next run.

## Also verify (already fixed in V1b post-ship — confirm live, add/keep regressions)
- The board starts via the runner (`scripts/start.mjs`) and appears in the Views menu
  serving the 13-list V1b pipeline (regression: `tests/own-port-start.test.ts`).
- `data/library.json` shows "Kanban Loop" (no "V1a").

## Out of scope
- Replacing the web channel's generic design or teaching it about kanban (it stays generic).
- The operative test interface (untouched).
- Rich-media notifications.

## Acceptance criteria — print each as a numbered FINDING line, checked from the LIVE app

1. **FINDING 1** — With the default operative `up`, the http-gateway is running and the
   board server has the gateway URL (no "Start … disabled" log). Print the gateway URL the
   board uses.
2. **FINDING 2** — Moving/starting a card onto Plan in the running board dispatches a real
   `autothing-plan` run through the gateway: show the card minting a runId and advancing
   (or parking with a visible reason), driven from the embedded UI — not a standalone call.
3. **FINDING 3** — "Open web chat" in a Discuss card navigates the running Garrison to the
   web channel in James mode with the card context. Show the resulting URL + the loaded
   James-mode surface.
4. **FINDING 4** — A brief produced in Discuss is linked onto the card (`card.briefPath`)
   without a manual edit; show the card's brief link after the round-trip.
5. **FINDING 5** — A list's configuration (skill / execute-prompt / router-prompt /
   validNext / trigger / mode) can be edited in the running board UI and persists to
   `board.json`; show a before/after and the engine using the new config.
6. **FINDING 6** — The board is started BY THE RUNNER (not a manual `server.mjs`) and shows
   in the Views menu; print the start path + the menu entry.
7. **FINDING 7** — Every slice's evidence is a walkthrough of the LIVE running Garrison
   (embedded board on :7777), not a standalone render.

End with the literal final stdout line:

```
KANBAN-LOOP-V1C OK
```
