# D55: the wake turn on the conversation doors, the pill, the record button

Node: goncalos-macbook-pro, 2026-09-03 20:12Z-20:35Z. Checks run against the
reloaded build on `http://127.0.0.1:8777` with a WebKit iPhone 12 emulation
(390x844) and the Capacitor bridge stubbed the way `tests/e2e/capture-page.spec.ts`
does.

- `vitest.txt`: the five suites that pin D55 and the cursor probe fallback.
- `pill-before-tap.png`, `pill-after-tap.png`: the transcript unpinned by a
  wheel on `.cc-session-scroll`, the jump pill at y=609 tapped, the scroller
  back at scrollTop 7965 of 7965 and the pill gone. Before the fix the tap
  landed on the row behind the pill (the `:active` transform replaced the
  `translateY(-100%)` lift).
- `composer-idle.png`, `record-idle.png`: the record button idle with the
  concentric-circle icon beside RECORD, matching the icon-plus-label shape of
  ROUTE / DICTATE / ATTACH.
- `record-live-hint.png`: after the tap the button reads STOP with the live
  dot, and the "Broadcasting. Say "Zeca" ..." hint sits above the composer
  at x=16..374 of 390, three lines, inside the viewport (it used to hang off
  the 84px button and run off the right edge).

Runtime state after the redeploy: composition `running`, 43 verifies green,
capture-service pid 33585 on the installed copy that carries the conversation
doors (`grep -c /api/conversation/ .../capture-service/lib/digest.mjs` = 4)
and the English pin for the broadcast (`screenSttLanguage` in
`.../lib/ingress.mjs`). The first `node:redeploy` of the evening came back
DOWN: dev-madrid had stationed `cursor-runtime` in the shared manifest (rev
35, 19:41Z) and this Mac's cursor-agent 2025.10.01 has no `status --format
json`; the probe now falls back to the plain `status` verdict and `up()`
was re-run through the runner API.
