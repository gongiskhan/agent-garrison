# D56: the answer comes back to the phone, pushed and spoken

Node: goncalos-macbook-pro, 2026-09-03 21:18Z-21:50Z. Checks run against the
redeployed build on `http://127.0.0.1:8777` (commit `e76a0867`) with a WebKit
iPhone 12 emulation (390x844), the Capacitor bridge stubbed the way
`tests/e2e/capture-page.spec.ts` does plus a `GarrisonSpeech` stub that records
what it is asked to say, and the conversation ledger the record button watches
(`GET /api/conversation/:id` and `/log`) served by the script: baseline total
40, then a capture-origin user message, then a discuss stretch (started,
assistant session-event, ended).

- `vitest.txt`: the six suites that pin D56 (50 tests): the server-side reply
  watch, the APNs template, the wake bus, the digest door, the page-side fold
  and speech, vocabulary.
- `record-live-hint.png`: the broadcast just started, STOP with the live dot,
  the wake-word hint above the composer.
- `record-heard.png`: the hit landed in the ledger; the hint is replaced by
  "Heard: Zeca, what is on this screen" in the same box.
- `record-after-answer.png`: 8 s later the heard line is gone and the hint has
  NOT come back (`captured`); the broadcast is still live.

The script's log for the same run: the watcher's first poll was
`/log?fromIndex=40` (the baseline came from the meta GET), the page POSTed
`/api/voice/spoken {"text":"The screen shows the Garrison Conversations page
with the record button live."}` BEFORE `GarrisonSpeech.speak` received the
same text, and the `[route: ...]` / `[orchestrator-active]` trailer lines never
reached the synthesizer. A typed turn produces none of this (no
`origin: "capture"` user message).

Trap for the next script of this kind: the shell registers `public/sw.js`, and
a service worker answers fetches BEFORE Playwright's `page.route`, so every
mocked ledger read hit the real (empty) thread until the context was opened
with `serviceWorkers: "block"`.

Runtime state after the redeploy: this Mac `running`, 43 verifies green,
capture-service pid 59247 on the installed copy that carries the reply watch
(`lib/conversation-reply.mjs` present, `conversation_reply` in `lib/wake.mjs`);
the mini fast-forwarded to `e76a0867`, `running`, capture-service pid 77558,
`POST /spoken` answers 401 without the token. dev-madrid not redeployed (another
plan's dirty tree, see the handoff).
