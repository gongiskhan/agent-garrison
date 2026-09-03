# Handoff - the Garrison app run (September 2026)

What this run did: the September 2026 plan "one app, the web channel home, one
voice layer, screencast inside conversations" ran as gates G0-G8 on
`node/goncalos-macbook-pro`, each gate committed and deployed to this node's
live instance, decisions D1-D48 recorded in
`docs/decisions/2026-09-garrison-app.md`, evidence under
`evidence/garrison-app/<gate>/`. Everything a machine could prove is proven:
vitest, typecheck, playwright (both configs), XCTest on the mini's simulator,
live probes over the tailnet, TestFlight builds after every native gate.

What it could not do is hold a phone. The plan's criterion for a native gate
is the phone, not the simulator, so every phone check below is yours. Nothing
here is known broken; it is unverified where marked.

## 1. Phone checks (the gate criterion, yours)

Install the latest TestFlight build (`evidence/garrison-app/g8/testflight.txt`)
on the iPhone and walk this list on the real device against this node
(`https://goncalos-macbook-pro.tail31efa.ts.net`):

1. First launch with no node: the bootstrap screen asks for a node URL and a
   capture token; add this node. The shell loads at the bare host; the sidebar
   shows Conversations, Kanban Loop and every equipped fitting.
2. Conversations at `/talk`: send a message, get the reply, reopen the app and
   find the thread. The record button sits in the composer only because the
   native bridge is present. Tap the search field and the message field and
   confirm the page does not zoom (D45; the 2026-09-02 evening screenshot was
   the 16/15 focus zoom, fixed in the shell viewport, needs the node on
   `main` at or after this commit).
3. Record button: tap, grant the microphone (the consent sheet is native),
   speak, stop. The digest message posts back into the SAME thread (G5,
   D41); the transcript is the digest, summarisation is a follow-up.
4. Capture page (`/capture`, shown only in the app): the microphone lane and
   the broadcast picker (screen capture consent is native), the live status,
   a session that ends cleanly.
5. Push: on first launch the app registers with APNs and posts the device
   token to capture-service. Today NO device is registered on this node, so
   every push falls back to web push (`notify_fallback_web` counts them).
   After registration, trigger a notification (a Kanban card done, or a
   conversation reply while backgrounded) and tap it: it deep-links into
   `/talk/<thread>` or the Kanban row (G4). Cold start (app killed) must land
   on the same route; that path was verified through the simulator DEBUG seam
   only (`pushRoute` KVO on `isLoading`).
6. Node switch: Settings, pick a second node, the webview reloads on the new
   origin, Conversations show that node's threads. The list is web, the
   reload is native (D38).
7. Embedded fitting views inside the app (G6, D46): open an own-port fitting
   from the menu; it embeds full-width under the app bar, which shows Back,
   the fitting's name and the menu; the desktop browser still gets the
   side-by-side layout.
9. Phone chrome (D46): every page has the app bar (menu button, page name,
   node name with the session dot, New); the menu slides in from the left
   and closes on a tap outside or on a row. Conversations: one conversation
   row (past-conversations toggle at the far left, then name, then search),
   no floating toggle, no chat status row. Kanban Loop: one column at a
   time with the column strip above it, cards and sheets sized for a thumb.
   Verified in WebKit at 390x844 and 440x956 against this node's prod build
   (`evidence/garrison-app/phone/webkit-*.png`); the phone and the simulator
   are yours.
10. Conversations on other nodes (D48): in the thread list, tap a row from
   another node (or "+ New" on another node). The window stays on THIS node,
   at `/mesh/talk/<node>/<id>`, with the app bar (Back, "Conversations on
   <node>") above the conversation framed from its home node; in Safari, on
   a Home Screen install and in the app alike, no tab and no Safari
   hand-off. Inside that conversation, a row from a third node (or from this
   one) lands the same way. The record button is absent inside a framed
   conversation (no native bridge in a cross-origin frame; follow-up). Needs
   the OWNING node on this commit or later (`/frame/talk`), which dev-madrid
   and the mini are; the Air is not. Any app build works: the fix is in the
   shell. The node switcher in Settings still switches the whole webview and
   keeps the current page across the switch (D47).
8. Pendant (G7): with the real pendant, Pair, Connect, watch `connected` and
   the battery, speak and see the words in the "Hearing" panel, Disconnect
   (stays paired), Forget (drops the pairing). No hardware was in reach of
   this run; the mock harness (`ios/Tests/PendantPluginMockTests.swift`) is
   the only proof so far.

If any step fails, the evidence README of that gate says what the run saw on
the simulator and where the code is.

## 2. Credentials and node state

- `ELEVENLABS_API_KEY` is not in this node's vault. capture-service falls
  back to Deepgram Aura for read-aloud (D21); seal the key when you
  want ElevenLabs voices back. Optional, not a blocker.
- APNs: the keys are in the vault; no device token is registered yet (see
  phone check 5).
- APM on this Mac is 0.11.0; dev-madrid wrote the committed
  `compositions/default/apm.lock.yaml` with 0.24.0. The lock regenerates on
  every `up()` here as a 135-line diff and was restored from HEAD after each
  one, never committed. Upgrade APM on this Mac to 0.24.0 to make the diff go
  away.
- The `coord-agentmail` MCP refuses connections on this Mac (ConnectionRefused
  at session start, every session of this run). The coordination intent for
  this run went through `coord-mcp` instead.
- Stale tailnet serve entries: `io.garrison.dev.plist` exists but is not
  loaded, and the old `:8445 -> 7777` mapping in the memory note is dead;
  the shell is at the bare host (443 -> 8777). Nothing to fix for the app;
  clean up when convenient.
- Mesh peers: dev-madrid and the mini were converged again to `cbe5d512`
  (D47) and reloaded on 2026-09-03 00:45Z; before that, dev-madrid
  (`d88a54cb`) and the mini (`ae135cf7`) were
  converged and redeployed on 2026-09-02 18:30Z and now serve the
  `viewport-fit=cover` shell; only the Air (offline that day) still runs the
  pre-plan code until its own `npm run node:redeploy` from `main`. The phone
  symptom this fixed: a peer's shell without `viewport-fit=cover` paints under
  the status bar inside the app (the 2026-09-02 screenshot); against a
  converged node the same build clears the island. Details, including the
  mini's unrelated vault-git-sync conflict that blocked its first `up`, in
  `evidence/garrison-app/phone/README.md`. This node still runs its own
  `cb9c9fbf` build; `main` is two commits ahead of it (dev-madrid's kanban
  card-id hardening), which reaches it on its next redeploy.

## 3. Operator-triggered follow-ups

- **Remove the legacy fittings.** `evidence/garrison-app/g8/remove-web-channel-default.patch`
  deletes `fittings/seed/web-channel-default/` and
  `fittings/seed/deepgram-voice/` plus their `data/library.json` entries.
  Not applied (invariant I12). `git apply --check` passes on `57129034`.
  When you apply it, also: repoint `tests/web-channel-pwa.test.ts`
  (`UI_DIR` reads `manifest.json`, `sw.js`, `index.html` from the legacy ui
  dir) at the shell's PWA files, drop the legacy path from
  `CONVERSATION_SURFACES` in `tests/vocabulary.test.ts`, and delete
  `compositions/openai/.garrison/last-up.json` entries for both ids (a
  tracked generated artifact; it refreshes at the next `up()`). Every other
  reference is an id string used as a notify origin or a fallback status
  file name and stays harmless.
- **Mac recording (D42, D14).** Deferred: `screen-share-default` as a
  capture-service client. File plan: `fittings/seed/screen-share-default/lib/capture-client.mjs`
  (ffmpeg to PCM over the same ws framing capture-service already accepts),
  `scripts/server.mjs` gains `/record/start|stop`, `apm.yml` gains
  `CAPTURE_TOKEN` in `secret_scope` and `consumes: voice`; the shell forwards
  `/api/record/*` from `packages/talk/src/router.mjs`; the record button
  renders when either the native bridge or that fitting is present. Until
  then a Mac browser shows the composer unchanged.
- **Digest summarisation (D41).** The digest message is the transcript. A
  follow-up has the Operative summarise it into the thread.
- **`POST /capture/conversation/active`** exists on capture-service (pin a
  session to a conversation) but no shell or iOS caller is wired yet; the
  record button reaches the same effect through the conversation id on the
  session itself.
- **Live smoke residue.** Thread "G5 live digest" (`g5-live-mtk3hh1n`) in
  Conversations is the G5 live smoke; delete it when you like.

## 4. Debt seen on the way (not this run's)

- Stale 27xxx/7xxx prose in fitting `summary:` texts (browser-default,
  ports-default, monitor-default, power-default, screen-share-default) and the
  base-family `DEFAULT_PORT` fallbacks in every own-port fitting's config
  (`omi-channel` 7094, `automations` 7090, `browser-default` 7084, `drill`
  7096, `garrison-assistant` 7095, `file-browser` 7091, `kanban-loop` 7089,
  `improver` 7093). The runner always projects `GARRISON_<ID>_PORT`, so the
  live processes bind 8xxx; only the fallback (printed by a bare `--probe`)
  is stale. One sweep, `tests/instance-isolation.test.ts` as the guard.
- automations `defaultRunConnector` passes action args as one argv element,
  so `audio_base64` is bounded by the OS single-argument ceiling. Mitigated
  in the voice catalog text (use `path` over ~100 KB). Real fix: args over
  stdin or a temp file, a protocol change for every `connector.mjs`.
- `scripts/tailnet-serve-views.mjs` enumerates the status dir before the last
  status file lands after `up()` (a ~100 ms race); harmless while mappings
  persist across runs, but a NEW own-port fitting could miss its first
  publish. Fix: `garrison-redeploy.sh` waits for the composition's own-port
  set, or the script reads the composition rather than the status dir.
- The runner's one-shot orphan sweep (`reconcileOrphanedOwnPortFittings`)
  SIGTERMs any pid named in an own-port status file whose composition is not
  running. Correct for real orphans; a test that writes its own pid into a
  fake status file gets killed (G6 found this). Tests must name no live pid.
- `tests/e2e/shell-overhaul.spec.ts` carried two stale tests since
  2026-08-28 (fixed in G6).
- Capacitor: a plugin built with a bare init has no listener tables
  (`eventListeners`, `retainedEventArguments` are nil until the bridge's
  `load(on:)`); `notifyListeners` drops events silently. Any plugin test
  harness mirrors `load(on:)` first (`PendantPluginMockTests.makePlugin`).

- **14 stale e2e specs in the base playwright config** (identical on
  desktop-chromium, tablet and mobile; `evidence/garrison-app/g8/README.md`
  has the breakdown): `landing.spec.ts` expects the pre-2026-08-30 site copy
  and two screenshots, and `site/index.html` carries em dashes in an SVG
  label and the Kanban caption; `quarters-crud.spec.ts` and
  `settings.spec.ts` fail in the sandbox `GARRISON_CLAUDE_HOME`;
  `muster.spec.ts`, `muster-standing.spec.ts`, `coordination.spec.ts` look
  for test ids and verdicts the pages no longer produce. Plus
  `web-channel-chat.spec.ts` on mobile only under the base config (no
  clipboard permission there; green under `playwright.web-channel.config.ts`,
  which owns it - the base config should ignore those two specs). None touch
  this run's surfaces; every spec the run touched is green. Not fixed here
  on the operator's mid-run budget call.
- `next dev` under the base playwright config can lose a route manifest in
  `.next-e2e` mid-run ("Failed to generate static paths ... Unexpected end of
  JSON input"), after which every page times out. Running one project per
  `playwright test` invocation avoided it; a proper fix is a retry or a
  fresh dist dir per project in the config.

## 5. Reviews not done

Per the operator's instruction mid-run (usage budget), the review phases for
G3-G7 were skipped. What needs eyes first: `packages/talk/src/router.mjs`
(the `/api/record/*` and `/api/voice/*` mounts, `pipeUpstreamSse`),
`ios/GarrisonApp/Plugins/GarrisonCapturePlugin.swift` and
`GarrisonPushPlugin.swift` (permission and token paths, invariants I3-I6),
`src/components/capture/CapturePage.tsx`, and the G4 push deep-link routing
on both sides (`PushRouteListener` in the shell;
`GarrisonBridgeViewController.swift` and `GarrisonPushPlugin.swift` in
`ios/GarrisonApp/`).
