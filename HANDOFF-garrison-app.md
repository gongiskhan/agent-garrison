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
3. Record button (D50, D54): tap, grant the microphone and the broadcast
   (the consent sheets are native). A hint above the button says
   "Broadcasting. Say "Zeca" and then your request ...". Say "Zeca, what is
   on this screen" and pause: within a few seconds a USER turn appears in
   the SAME thread with your words and up to three attached screen frames,
   and the reply follows; the confirmation "Sent to the conversation: ..."
   is spoken or pushed. Stop: the digest message still posts at the end
   (D41). The 2026-09-03 phone run saw NOTHING here, on the session and
   after the stop alike: the conversation id was looked up at dispatch
   time, after the capture window, when the stopped broadcast was already
   gone from the ingress, so the hit fell through to the classifier lane
   and became a card (or a note), never a turn. D54 binds the id at the
   wake hit and falls back to the persisted session record; the regression
   is `tests/capture-service-wake-conversation.test.ts` ("keeps the
   conversation bound at the wake hit when the broadcast stops before the
   window closes"). The 2026-09-03 evening phone run on `66042392` STILL saw
   nothing, and that one was the lane: the wake turn posted to the thread's
   old chat store (`POST /api/threads/:id/messages`), which a
   conversation-backed thread never renders (the page reads only the
   conversation ledger), so the turn was recorded and invisible; the digest
   went the same way. D55 moves both onto the conversation doors
   (`/api/conversation/:id/message` for the turn, the new `/note` door for
   the digest) and pins the broadcast's live transcription to English (the
   `pt` pin turned "what is on this screen" into Portuguese word salad; the
   pendant keeps `pt`). Regressions: `tests/capture-service-digest.test.ts`,
   `tests/capture-service-wake-conversation.test.ts`,
   `tests/conversation-store-read.test.ts` ("conversation router - note").
   Retest on a node running the D55 commit: this Mac or the mini, dev-madrid
   once it redeploys from `main` (see §2). Speak ENGLISH after "Zeca"; the
   turn appears in the open conversation as your words plus frames, the
   digest lands at the end as an unanswered note. If nothing arrives,
   `curl -s http://127.0.0.1:8097/health | jq .counters` on the node:
   `wake_conversation_turns` should count the hit,
   `screen_audio_transcription_skipped` means a pendant session was live
   and the broadcast was muted, `conversation_turn_post_failed` means the
   talk API refused the turn (the note lane took it instead), and
   `digest_post_failed` that the digest note was refused. "Zeca"
   itself survives the English pin through the `stt_keyterms` list.
3b. Composer mic (D49, D52): tap the mic (no sheet), speak ENGLISH, watch
   the level bar move and each sentence land in the message box after the
   pause; tap Stop, the text stays, edit, Send. The dictation panel carries
   an EN / PT / Auto switch (default EN, remembered per browser in
   `talk.stt.language`); before D52 every clip was transcribed with the
   server's `pt` pin, which is what made English dictation read as garbage.
   Flip to PT for a Portuguese sentence and confirm it lands right too. Tap
   the mic again straight away, with text already in the box and while the
   reply is still streaming: it dictates again. Discard removes only what
   was dictated. Hold the mic for the hands-free sheet.
3c. Composer layout (D53): the message box sits alone on the top row and
   the controls (Route, Dictate, Record, Attach, Send) sit beneath it with
   their labels, on the phone as on the desktop. Paste or dictate a long
   text: the box grows with it up to half the screen, then scrolls inside.
   Send empties it back to one line. Verified in WebKit at 390x844 against
   this node's build (`evidence/garrison-app/phone/webkit-390-composer-*.png`
   if present; otherwise the phone is the first look).
3d. Feedback after the hit (D56): with the broadcast live, say "Zeca, what is
   on this screen" and pause. Expected, in order: the "Heard: Zeca, what is
   on this screen" line replaces the wake-word hint under the record button
   for 8 s and the hint does NOT come back for the rest of the broadcast; the
   confirmation push "Sent to the conversation: ..." arrives; the session
   answers (triage, then the discuss stretch, some tens of seconds); while
   the app is open on the conversation the answer is SPOKEN by the phone,
   and a second push "Zeca: <answer>" arrives either way (tap it: the
   conversation opens). Switch to another app after the hit: the "Zeca"
   push carries the answer, nothing is spoken (the page is hidden). Say a
   second "Zeca ..." after the first answer: a second turn, a second answer,
   no repeat of the first. A typed message in the composer is never spoken.
   On the node: `curl -s http://127.0.0.1:8097/health | jq .counters` -
   `wake_conversation_replies` counts answers pushed,
   `wake_conversation_reply_timeouts` answers that never came in 5 min,
   `wake_replies_spoken` answers spoken on a mic/pendant session,
   `spoken_registered` the echo-guard registrations from the page; and
   `~/.garrison/capture/wake-results/<eventId>.json` gains `reply` with the
   text, duty and `delivery` (`spoken` | `push` | `undelivered`). If the
   "Zeca" push never comes but the counter moved, check the APNs receipts
   in the capture-service log (`wake reply <eventId> -> discuss (...)`);
   `undelivered` with push disabled is expected on a node without the APNs
   key. If the phone speaks the answer AND the broadcast turns it into a
   new turn, the echo guard missed: `spoken_registered` should have moved
   before the speech started. Regressions:
   `tests/capture-service-conversation-reply.test.ts`,
   `tests/talk-capture-feedback.test.ts`, the D56 cases in
   `tests/capture-service-wake-conversation.test.ts` and
   `tests/capture-service-apns.test.ts`. No native change, no new
   TestFlight: the app already carries `GarrisonSpeech`.
3e. The answer reaches the phone while the app is open (D57, NEEDS the
   TestFlight build from the D57 commit or later): with the broadcast live
   and the conversation on screen, say "Zeca, what is on this screen". When
   the answer comes, a BANNER "Zeca: <answer>" shows at the top of the
   screen with a sound, in the app, on the conversation. Before D57 the
   Capacitor bridge owned the notification center and dropped every push
   that arrived with the app in front; the same push showed only when the
   app was in the background, which is what the 2026-09-04 test push
   proved ("i see the push now" with the app closed, nothing on the open
   conversation). Tap the banner from another app: the conversation opens
   at `/talk/<id>`. Under the record button, a notifications line shows
   ONLY when the phone is not registered on this node: "Turn on
   notifications" (first broadcast also prompts on its own), "Retry" after
   a failed upload, or the Settings path when notifications are denied;
   registered means no line. A spoken request that triage alone answers
   (a question back, no discuss stretch, as the 06:15Z hit "send a message
   to him saying that dinosaurs are awesome" got) is now SPOKEN by the
   page about 20 s after the triage stretch ends, and the status line reads
   "Zeca is answering ..." in between. On the node the phone's registration
   is `~/.garrison/capture/devices.json` (`device_name` is the phone's own
   name from this build on; the earlier "Mac mini" entry is the same
   token under the stale App Group name). Regressions:
   `tests/talk-capture-feedback.test.ts` (idle fallback, `describePushStatus`),
   `ios/Tests/BridgePluginRegistryTests.swift`
   (`testBridgeLeavesNotificationsToPushManager`).
3f. The spoken answer is the voice layer's voice (D58, no new TestFlight:
   web-side only, needs this node reloaded). With the broadcast live, ask
   Zeca something and listen: the answer is read in the Deepgram voice the
   pendant uses (`/health` on capture-service says `ttsBackend: "deepgram"`
   here; the ElevenLabs key is unset on this node, set it in the vault to
   switch), NOT the default iPhone voice the D57 build spoke with. A long
   answer plays in sentence-sized clips with no gap you would notice; the
   iPhone voice is heard only when the voice layer cannot render (no TTS
   key at all, node unreachable). On the node each clip is one
   `POST /tts` line in `~/.garrison/ui-fittings/capture-service.log`.
   Regressions: `tests/talk-capture-feedback.test.ts` (`speakReply` D58,
   `chunkForTts`).
4. Capture page (`/capture`, shown only in the app): the microphone lane and
   the broadcast picker (screen capture consent is native), the live status,
   a session that ends cleanly.
5. Push: on first launch the app registers with APNs and posts the device
   token to capture-service. This Mac has the phone registered since
   2026-09-03T20:34Z; the mini has NO device (open the app pointed at the
   mini once), so on the mini every push falls back to web push
   (`notify_fallback_web` counts them).
   After registration, trigger a notification (a Kanban card done, or a
   conversation reply while backgrounded) and tap it: it deep-links into
   `/talk/<thread>` or the Kanban row (G4). Cold start (app killed) must land
   on the same route; that path was verified through the simulator DEBUG seam
   only (`pushRoute` KVO on `isLoading`).
6. Node switch (there is no Settings screen): the node badge at the top of
   the menu drawer lists the mesh roster and switches to any node the app
   knows; a node is added on the Capture page (menu, Command, Capture, shown
   only in the app), section Node, "Add a node" (shell URL + that node's
   capture token), which also has Switch / Remove per node. Pick a second
   node, the webview reloads on the new
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
   shell. The node switcher (drawer badge, Capture page) still switches the whole webview and
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
- Mesh peers: dev-madrid and the mini were converged to `8b543503` (D48,
  `/frame/talk` and the local `/mesh/talk` rows) and reloaded on 2026-09-03
  07:40Z; before that to `cbe5d512` (D47) on 2026-09-03 00:45Z; before that, dev-madrid
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

- **This Mac's node fell silent for an hour after the D49/D50 redeploy
  (2026-09-03 16:35Z-17:50Z); two causes, both fixed in `6a168ea0`.** (a)
  Orphaned next-servers: `next start` answers SIGTERM by closing its listener
  and waiting for every connection to drain, and the fittings hold keep-alive
  and SSE connections forever, so the old app server survived the launchctl
  restart as an orphan (parent 1), kept all 17 fittings on the OLD code
  (which is why "Zeca" did nothing on this node), and starved the new server
  with hung keep-alive requests. `scripts/lib/app-server.sh`, sourced by both
  `garrison-redeploy.sh` and `garrison-reload.sh`, now records the pid on the
  app port, waits 10 s after the restart, ends it, and reaps any next-server
  whose parent is the reaper (`next dev` children stay). (b) `readLibrary()`
  re-read, parsed and validated ~50 manifests on nearly every API request;
  a few hundred tailscale-proxied requests kept the event loop in that alone
  (profiled with the inspector, `--cpu-prof`-style sampling at 500 us).
  `src/lib/library.ts` keeps one snapshot keyed on mtime+size of the registry
  files, the fitting directories and every manifest. The operator killed the
  orphans by hand this time (the session's classifier refused my `kill`);
  the `up()` that followed failed on `basic-memory` verify timing out under
  load 150+. The `node:reload` of `6a168ea0` (18:50Z) reaped the last orphan
  itself (`[app-server] ending orphaned next-server 9144`), and its `up()`
  passed all verifies: 16 fittings, capture-service pid 12389 with the D50
  flag on, `/talk` serving the dictation bundle over the tailnet. This node
  is now the only one on the fixed build; the peers run `66c84865` (mini) and
  `5af91f90` (dev-madrid) and get the app-server guard and the library cache
  on their next redeploy.
- **D50 was dark on every node, and would have stayed dark after a redeploy.**
  The state service on dev-madrid, not git, is the source of truth for a
  composition's manifest: `up()` materialises the service copy over the
  working tree and only Muster edits flow back. `66c84865` committed
  `screen_audio_transcribe: true`, the service still held `false`, and every
  node's `up()` rewrote the working tree to `false` and started
  capture-service with `GARRISON_CAPTURESERVICE_SCREEN_AUDIO_TRANSCRIBE=false`
  (verified in the live process env on dev-madrid and the mini). Fixed by
  pushing HEAD's manifest to the service (rev 30 -> 31) with the new
  `tsx scripts/state-push-composition.ts default` (shows the diff, refuses an
  un-committed manifest, rev CAS), restoring the committed `apm.yml` on both
  peers and restarting capture-service through
  `POST /api/fittings/capture-service/restart` - both peers now run with the
  flag true (dev-madrid pid 1085939, mini pid 14713). Rule for the future: a
  committed `compositions/*/apm.yml` change is not live until it is pushed to
  the service; `scripts/garrison-redeploy.sh` does not do it for you (it
  should - see §4).
- dev-madrid carries a local commit `5af91f90` ("shells: G0") on top of
  `66c84865` from another session's plan; not this run's, left alone.
- **2026-09-03 evening (`66042392`, D52-D54): this Mac and the mini are
  redeployed; dev-madrid is NOT.** This Mac: `node:redeploy` 18:35Z-18:40Z,
  every verify passed, capture-service pid 76878 on the installed copy that
  carries the D54 binding (`evidence/garrison-app/voice-d52-d54/`). The
  mini: fast-forward from `66c84865` and `node:redeploy` at 18:40Z,
  capture-service pid 17109, same check. dev-madrid's tree at 18:32Z held
  another session's plan mid-flight ("shells", HEAD `32ab43dc`, nine
  modified tracked files and six untracked, `fittings/seed/kanban-loop/ui/main.tsx`
  and `src/lib/mesh/peer-proxy.ts` written seconds earlier), so the merge
  was refused by git and not forced, and no redeploy ran there: it would
  have built that half-done tree and dropped its operative. The phone points
  at dev-madrid, so until that session lands and dev-madrid redeploys from
  `main`, phone checks 3, 3b and 3c run against this Mac or the mini through
  the drawer's node badge, after adding the node on the Capture page.
  When dev-madrid is free: `git merge
  origin/main` (it has local commits; never `--ff-only`, never discard the
  uncommitted work) and `npm run node:redeploy`.
- **2026-09-03 night (D55, `e11a78a6`): this Mac and the mini redeployed;
  dev-madrid still NOT** (on `main` at `f5446e15`, the "shells" plan's G6
  mid-flight with three modified tracked files, left alone). The mini:
  fast-forward from `66042392`, `node:redeploy` at 20:40Z, 43 verifies
  green, capture-service pid 71914 on the installed copy with the
  conversation doors. This Mac's first `node:redeploy` (20:12Z) built and came back
  DOWN: dev-madrid had pushed rev 35 of the shared `default` manifest at
  19:41Z stationing `cursor-runtime` (a `cursor-local` secondary target),
  and this Mac's `cursor-agent` is 2025.10.01, whose `status` has no
  `--format json`, so the verify probe read a logged-in box as logged out and
  `up()` aborted with every fitting stopped. `cursor-agent update` is a
  no-op on that version. The probe now falls back to the plain `status`
  verdict (`fittings/seed/cursor-runtime/scripts/bridge.mjs`,
  `tests/cursor-runtime.test.ts`); `up()` re-run through the runner API.
  The shared-manifest change itself is dev-madrid's and was left alone; the
  local `apm.yml` diff you see on this Mac IS that rev-35 refresh, not
  something to commit here.

- **2026-09-03 late (D56, `e76a0867`): this Mac and the mini redeployed;
  dev-madrid still NOT** (same reason as D55). This Mac: `node:redeploy`
  at 21:30Z, 43 verifies green, capture-service pid 59247 on the installed
  copy with the reply watch. The mini: fast-forward from `e11a78a6`,
  `node:redeploy` at 21:15Z, `running`, capture-service pid 77558. The
  feedback loop needs the phone's APNs registration to be live on the node
  you test against (§1 item 5): without it every answer still lands in the
  conversation and is spoken in-app, but the "Zeca" push is skipped and the
  wake-results record reads `delivery: "undelivered"`. No `ios/` change, so
  the TestFlight build from D50 is the one to test with. WebKit evidence in
  `evidence/garrison-app/voice-d56/`.

- **2026-09-04 morning (D57): this Mac and the mini reloaded; dev-madrid
  still NOT.** App-only change on the node side (`packages/talk`,
  `src/components/talk`), so `node:reload`, not a redeploy; capture-service
  is untouched. The native half (Capacitor no longer owns the notification
  center; `device_name`) needs the TestFlight build cut from the D57 commit:
  until the phone runs it, an in-app push still shows nothing while the app
  is in front, and the notifications line under the record button reads the
  status through the D50 `GarrisonPush` plugin (already in the app).
  Evidence in `evidence/garrison-app/voice-d57/`.

- **2026-09-04 (D58): this Mac and the mini reloaded; dev-madrid still
  NOT.** `packages/talk/ui/capture-feedback.ts` only, so `node:reload`; the
  same reload also made the capture-service log rotation
  (`src/lib/own-port-lifecycle.ts`, `.log.1`) live. No `ios/` change, so
  the D57 TestFlight build is still the one to test with. Evidence in
  `evidence/garrison-app/voice-d58/`.

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

- The routing-gate reply to a wake turn carries `Card:
  http://127.0.0.1:8089/...`, a machine-local URL handed to the client (the
  HARD RULE in CLAUDE.md "Instances, ports, and deploying"); on the phone it
  is a dead link. The kanban-loop reply builder should emit a relative
  `/fitting/kanban-loop/...` route or a `garrison://` link.
- The capture digest says "from Mac mini" for a broadcast that came from the
  phone: the device label is the node, not the sender.
- Another session left uncommitted capture-service work in this Mac's tree
  during the D55 run (pronunciation aliases, `EKOA` keyterm:
  `fittings/seed/capture-service/apm.yml`, `lib/deepgram-rest.mjs`,
  `lib/pronunciation-aliases.mjs`, `tests/capture-service-deepgram-rest.test.ts`,
  `tests/capture-service-pronunciation-aliases.test.ts`). Not staged here;
  its untracked test fails `npm run typecheck` (TS7016, no declaration in
  `tests/capture-service-mjs.d.ts`) until that session lands it.
- A shared-manifest change from one node can take another node down at its
  next `up()` when the stationed fitting's verify depends on a local tool
  version (the cursor-runtime case above). `up()` should report which node
  changed the manifest and when, and a verify that fails only on this node
  should degrade that fitting, not abort the composition.

- `scripts/garrison-redeploy.sh` should push HEAD's `compositions/*/apm.yml`
  to the state service (what `scripts/state-push-composition.ts` does) before
  `up()`, or `up()` should treat a working-tree manifest that matches HEAD and
  differs from the service copy as the newer intent. Today a redeploy of a
  committed manifest change silently reverts it (the D50 flag, above).
- Under load 150+ this Mac's `up()` failed on `basic-memory` verify (`exit
  null: verify timed out`) and left an orphan `basic-memory project info main`
  running; the verify has no budget of its own beyond the runner's timeout.
- The Mac accumulates process debt: ~44 orphan `tail -F`, ~200 Chrome
  crashpad zombies, launchd at 16 % CPU. Not Garrison's, but it is what
  pushed the load to 200 and made both faults above visible.
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

- **No feedback at the hit itself on the broadcast lane (D56).** The first
  sign that "Zeca" was heard is the "Heard:" line on the open page or the
  confirmation push, both a few seconds after the phrase, because the
  broadcast session is not a speakable session (ADR §6) and
  `bridge.status()` does not expose the broadcast session id for the page
  to react earlier. A short native tone or haptic at the wake hit (the
  server telling the app through the broadcast socket) is the fix; native,
  so a TestFlight.
- **An out-of-app spoken answer (D56).** The push carries the answer as
  text; hearing it while in another app needs a Notification Service
  Extension synthesizing the body to a sound file at delivery. Native;
  deferred until the push path is confirmed on the phone (D57 confirmed
  APNs delivery; the in-app presentation was the missing piece).
- **`node:reload` takes the voice layer down for about a minute.** The
  gateway and every own-port fitting are children of the launchd job (the
  systemd unit on dev-madrid), so `launchctl kickstart -k` in
  `scripts/garrison-reload.sh` kills them with the app server and `up()`
  respawns them one to two minutes later. The 2026-09-04 06:53Z pendant ask
  fell into that window: capture-service was down, the pendant's uploader
  showed its failed state and the wake phrase was never heard; the pendant
  session resumed on its own once the new process listened
  (`speakable.byMode.pendant: 1` on `/health` afterwards). Keeping fittings
  alive across an app restart means spawning them outside the job (their
  own launchd agents, or a detached session leader launchd does not track)
  and having the new app server adopt the status files instead of the
  orphan sweep reaping them. CLAUDE.md's reload paragraph now says what the
  restart really does. Until then, do not reload while a phone session is
  live, and expect one lost ask per reload.
- **Capture turns are routed by inference (D57).** A spoken turn lands in a
  plain chat conversation with no routing pin, so the gateway may run
  triage alone and answer with a question (the 06:15Z hit). The talk page
  pins `discuss` only for `?source=discuss` / kickoff URLs. Decide whether a
  capture-created or capture-used conversation should carry a `discuss`
  pin (`apiSetRouting`) so a spoken question is answered by the operative,
  not gated; the gate's question now at least reaches the phone.
- **Stale App Group `device_name` ("Mac mini")** from the old Companion:
  D57 uploads `UIDevice.current.name` with the push token, so the voice
  layer's device list reads right from the D57 build on; the capture page
  still shows the App Group value until it is cleared on the app's first
  launch under the new bundle (a one-liner in `GarrisonCapturePlugin`).
- **Broadcast-mic STT quality** decides whether the wake phrase is heard at
  all: the English pin (D55) helped, `stt_keyterms` carries "Zeca", but a
  phone on a table across a room still misses. Deepgram's `keyterm`
  boosting per model and a louder gain on the ReplayKit mic sample are the
  two knobs not yet turned.

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
