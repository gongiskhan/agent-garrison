# BRIEF: Kanban Loop V1d — make EVERYTHING work in the live app (vision-verified)

## Why this exists
Prior passes were verified against a STUB gateway and standalone servers, so real
integration bugs shipped. Using the real running Garrison the user hit: **moving a card to
Plan shows "fetch failed" and nothing happens**, **"Open web chat" on Discuss does
nothing**, and "everything is broken". This pass fixes the Kanban Loop so EVERY list and
EVERY action actually works, proven by driving the real UI and LOOKING at the result.

## THE non-negotiable — drive the real app, with vision, no stubs
A thing is "working" ONLY when it has been exercised like a user would and the result was
SEEN:
- The real Next app on `127.0.0.1:7777`, the board embedded at `/embed/kanban-loop`, and
  the board own-port server **started BY THE RUNNER** (not a manual `node server.mjs`).
- The **real operative `up`** for the `default` composition, so the **real http-gateway**
  (`:4777`) and a real Claude operative are running. NO stub gateway anywhere.
- Drive with the repo's Playwright; **screenshot every meaningful state and READ the
  screenshot (vision)** — clicks, dispatches, watch streams, opened artifacts, the web
  chat. A real agent-list run takes MINUTES (a real Claude turn); WATCH it, wait for it,
  and confirm the card actually advances (or parks with a visible reason) — don't assert
  from a 200, assert from what's on screen.
- Reproduce each reported failure FIRST (capture it with vision), then fix, then re-drive
  and SEE it fixed.

## Known root causes to fix (confirmed during triage)
1. **`fetch failed` on dispatch.** The board own-port server was left running WITHOUT
   `GARRISON_GATEWAY_URL` (the runner's "already running → left in place" path skips env
   injection, and a keyless/gatewayless board is never healed), and repeated `up`s restart
   the gateway out from under in-flight `POST /chat` requests. Plus the board's
   `gatewayRunFn` `fetch` has no timeout and `/chat` blocks for the whole (minutes-long)
   turn. Fix the board↔gateway lifecycle + dispatch so: the board always resolves the live
   gateway (runner injects it on up AND heals an already-running board; robust default);
   a dispatch survives normal turn latency; a genuinely failed/again-unreachable dispatch
   leaves the card in a CLEAR state (e.g. stays put + a visible "gateway unavailable"
   note, or parks with a readable reason) — never a dead "fetch failed" with nothing on
   the card. Multiple boards / shifting ports (7089/7090/7091) must collapse to ONE
   runner-managed board with the right port in the status file + embed.
2. **"Open web chat" does nothing on Discuss.** Reproduce in the embedded board; fix so it
   opens the web channel in James mode with the card context and the chat is usable.
3. Any other breakage found while driving the matrix below.

## The functionality matrix — verify EVERY item live, with vision
Create real cards and click through. For each, screenshot + confirm visually.

**Board basics**
- New card → lands in Backlog; project chip, goalMode toggle.
- Horizontal scroll / responsive (phone width) — all 13 columns reachable.

**Manual lists — Backlog, To Do, Done, needs-attention**
- Move to each valid next list (the Move sheet shows the right targets).
- Start/Advance on a manual column moves to the first valid next.
- needs-attention: a parked card can be moved back out and re-run.

**Interactive list — Discuss**
- Open web chat → web channel in James mode with the card context (vision).
- The brief James writes auto-links onto the card (card.briefPath) on Move-out-of-Discuss.
- Discuss advances only by manual Move (no Start).

**Agent lists — Plan, Implement, Review, Adversarial Review, Test, Adversarial Test,
Walkthrough, Validate**
- Moving/Starting a card onto each dispatches a REAL run through the gateway: card flips to
  `running`, mints runId on first agent entry, the Watch stream shows live output, and the
  card advances to a valid next OR parks in needs-attention with a readable reason. WATCH a
  real Plan run end-to-end (minutes) and SEE the outcome.
- The router output exact-matches a valid next or parks (try a path that parks, too).
- Adversarial Review/Test are cross-model Codex passes (don't break that contract).
- Test runs batched on its scheduler beat (verify the beat path doesn't error).

**Per-card actions**
- Watch: live SSE for a running card; linked static logs when idle (vision both).
- Open: the artifact links resolve and open — plan (FLOW_PLAN), brief, session transcript,
  gate markers, logs, video link. Open each that exists (vision).
- List-config gear: edit skill / execute-prompt / router-prompt / validNext / trigger /
  mode / taskType / tier on an agent list AND title+validNext on a manual list; Save
  persists (board.json), survives reload, and the engine uses the new config; the board-rev
  CAS rejects a stale save.

**Cross-cutting**
- goal-mode card prepends /goal + acceptance on dispatch.
- The board survives a gateway restart and a Garrison restart (reconnects, no zombie ports).

## Out of scope
- Web channel staying generic (don't teach it kanban); the operative test interface; the
  web channel's own design.

## Acceptance — each proven from the LIVE app with a screenshot
Print numbered FINDING lines, each tied to a vision artifact:
1. Move/Start onto Plan dispatches a REAL gateway run; the card runs (Watch shows output)
   and advances or parks with a readable reason — NO "fetch failed".
2. Every agent list (Plan…Validate) dispatches + resolves correctly when entered.
3. "Open web chat" opens the web channel (James mode, card context) and is usable.
4. Discuss brief auto-links onto the card after the round-trip.
5. Every manual list's Move + Start works; needs-attention recovery works.
6. Watch shows live output for a running card and static logs otherwise.
7. Open resolves+opens each existing artifact (plan/brief/transcript/logs/video).
8. List-config edits persist + are used; CAS rejects stale saves.
9. ONE runner-managed board, correct port, survives gateway + Garrison restart.
10. A full vision walkthrough (screenshots) of the above exists; no broken path remains.

End with the literal final stdout line:

```
KANBAN-LOOP-V1D OK
```
