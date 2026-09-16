# CSG Cursor sessions and iOS false failover — 2026-09-16

Source fix: `98a6d976c7976eab24a3183fb6e2f1fd8dadb360`.

The user's phone showed missing CSG sessions, then a spinning Cursor row with no content and an unexpected switch from Madrid to MacBook Pro. These had distinct causes.

- CSG's September 11 production build lacked `BUILD_ID`; its supervisor was retrying startup while app and Shells were unavailable. The normal guarded reload restored the installed revision, then the supported tether repair restored forwarding. Four real Cursor desktop journals were present throughout. CSG's separate Two Homes/main rollout remains deferred; its existing generated composition edit was preserved.
- Three Cursor agent-start observations had neither saved output nor a controllable attachment. Their old activity survived fresh owner publications and appeared to keep working. Aggregation now expires those unlinked placeholders after five minutes. Journal-backed, resumable and attached sessions retain their ordinary visibility window.
- The native app used one three-second request to the full root page as its failover decision. A healthy cold Madrid root measured 3.127 seconds. The fix probes `/api/mesh/self` with eight seconds, confirms current-node failure after finding a healthy peer, serializes overlapping checks and prevents stale or cancelled checks from overriding manual selection. This is a reproduced failure mode, not a claim to have inspected the user's phone logs.

## Verification

- `npm run typecheck`: passed after the incoming Projects workspace was installed and obsolete generated types for its removed routes were backed up outside the checkout.
- `npm test -- tests/talk-mesh-sessions.test.ts tests/talk-structured-shell-browser.test.ts`: 22 passed. Includes local and republished peer placeholders, preservation of real sessions, Chromium/WebKit rendering and mobile shell interaction.
- Native source parses. All 11 existing/added `NodeFailoverTests` compile and pass against the actual Foundation/Combine shared source in a temporary Swift package on the Mac mini. This does not claim full iOS simulator or real-phone acceptance.
- Full iOS testing on the mini stops before compilation because Xcode 26.6's system components have not completed first-launch installation. Administrator authentication is required.
- TestFlight workflow run [35094691213](https://github.com/gongiskhan/ios-thing/actions/runs/35094691213) failed at checkout, before compilation or upload: the source repository is now private, while the release workflow assumed public access. The proposed repository-scoped read-only deploy key, CI secret and checkout patch require explicit approval after automatic approval review rejected that persistent credential grant. No credentials or workflow were changed, and build 43 was not delivered.

## Live rollout

Both Madrid and MacBook Pro completed normal guarded deployment with exit 0, each passing 39 fitting verifiers and reporting 14 healthy views. The Pro build required backing up obsolete generated types from `.next` as well as `.next-build`; its service was not stopped until the corrected build passed. Air and mini received committed source without restarts; the mini's unrelated Cursor edits were preserved.

Madrid's guarded redeploy completed with exit 0, all 39 fitting verifiers passed, default is running and all 14 current views are healthy. Public session aggregation returns four CSG Cursor desktop sessions, with no expired unlinked rows. A 393×852 WebKit journey on the public HTTPS origin rendered 19 transcript turns, opened a visible CSG terminal and checked executed output assembled from two separate printf arguments so command echo could not satisfy the check. The test terminal and wrapper thread were removed.

Madrid's first startup attempt exposed an existing vault-sync blocker. An orphaned `.git/rebase-merge` containing only `autostash` had blocked sync since 05:51 UTC. Local edits and both histories were preserved; the final tips merged without content conflicts. The autostash was retained under a separate pushed recovery tag before its incomplete metadata was quarantined. Canonical full sync passed at 12:38:10Z; no verifier was bypassed. Recovery decision card: `01M2N3PT5EZMCSH65JJVJBMMWW`.

Owner-local evidence:

- Madrid: `/tmp/garrison-session-fix-deploy-madrid-20260916-s85zq980/` (initial failure and successful retry), `/tmp/garrison-session-live-check-20260916-dev-madrid.tail31efa.ts.net.json`, `/tmp/garrison-vault-startup-recovery-20260916.json`.
- CSG: `/tmp/garrison-csg-session-recovery-20260916.iSHLKQ/`.
- Mini: `/tmp/garrison-native-failover-package-20260916.path` identifies the source-linked Swift test harness and log; `/tmp/garrison-node-failover-tests-20260916.path` identifies the blocked iOS test attempt.

## Subsequent transport outage

The final Pro browser check caught a later CSG relay outage before transcript rendering; it did not create a terminal. Madrid's corresponding relay and the direct CSG HTTPS origin also returned HTTP502. The owner SSH listener on Madrid's loopback port disappeared. The tunnel monitor's last successful tether probe was 12:47:51Z; Microsoft's control plane still advertised one host connection, but repeated local client replacements stalled before opening SSH. HTTPS to the relay itself answered promptly and neither environment had a proxy configured. A logged diagnostic connector likewise stalled at the relay handshake. Automatic repair remains enabled, and a fresh CSG tunnel-host restart was requested because the failed SSH leg prevents repairing that host remotely.

This outage supersedes any claim that the earlier successful browser journey proves CSG is currently reachable. Session discovery continued: a fifth real Cursor desktop journal appeared at 12:50:36Z and both deployed viewing nodes listed it without bringing back the expired placeholders. Both viewing apps remain healthy. The native release, stable CSG relay recovery, the final Pro browser pass and real-phone acceptance remain open.

## Completed Cursor turn still marked working — evening follow-up

The CSG relay is reachable again. The Java25 desktop session reported in the 20:56 phone screenshot has a real JSONL transcript ending in `{ "type": "turn_ended", "status": "success" }` at 18:08:22Z. A stop hook at 18:08:17Z was followed by another activity/start hook at 18:08:21Z. The Cursor lister ignored the explicit completion and supplied only transcript recency, so the older hook kept the session working under its six-hour trust window. This is separate from the earlier transcriptless placeholder problem.

Fix `89ca2156` reads the bounded Cursor JSONL tail and exposes the final turn completion with the journal modification time. Existing timestamp precedence then lets that completion outrank the older hook. A later prompt/assistant record clears the completion evidence, and a newer start hook still works before the journal catches up. Quiet assistant text alone does not claim completion. Legacy text journals retain their existing status behavior.

All 51 tests in `shells-listers.test.ts` and `shells-hooks-install.test.ts` pass. Regression cases cover successful, failed and cancelled terminal records, the observed stop/start/completion ordering, immediate and hour-old completion, and subsequent turn activity. JavaScript syntax and diff whitespace checks pass.

CSG source fast-forwarded from `20f0905d` to shared main. Before integration, its generated composition was backed up and proven byte-identical to the incoming committed file; it remains preserved in the named stash `csg-generated-composition-already-in-main-20260916-spinner-fix`. The planned deployment was the supported fitting restart; the desktop Cursor process and journals were not restarted or edited. Once the generated source difference was incorporated, the already-installed main-sync worker automatically attempted its full guarded rollout. The explicit restart correctly deferred to its deployment lease.


The automatic rollout exposed an APM compatibility error: CSG had Python APM 0.26.0, which refused lockfile paths written through the managed `.claude` link ("outside the project tree and no dynamic-root target matched"). The migration had already preserved the prior ownership lock, user-config snapshot and quarantine journal, and correctly stopped before cleanup. A supported observer start restored session access during recovery. CSG's APM was aligned to 0.24.0, the release already serving Madrid; its previous uv installation receipt is retained in the owner recovery directory. Normal guarded startup then completed successfully. No verifier or migration barrier was bypassed.

Final CSG health at 20:20 UTC: main/build `89ca2156`, composition running since 20:19:52Z, 20/20 fitting verifiers passed, 9/9 views healthy, zero home leaks, no active Conversation. The Two Homes migration is now complete, superseding the earlier deferral: backup `/home/ggomes/.garrison/backups/pre-two-homes-2026-09-16T20-12-02-560Z`; quarantine `/home/ggomes/.garrison/quarantine/2026-09-16T20-12-03-155Z-b85d6b58`. The normal deployment recorder marked this revision healthy, preventing repeated retries of the recovered rollout. Madrid remained healthy throughout.

The public Madrid API reports the affected Cursor session `idle`, `statusSource: transcript-events`, and `connected`. A 393×852 WebKit journey confirms zero spinners on the row, CSG group and filtered shell section, readable transcript turns, and an enabled Open shell action. Metadata-only receipt: `/tmp/garrison-cursor-completion-browser-20260916.json`; the screenshot stays on Madrid. CSG's composition backup, prior source ref and APM receipt are in the owner-local directory named by `/tmp/garrison-cursor-completion-20260916.path`.

The final WebKit Open shell journey from that same Java25 row also passed: visible terminal, executed marker output (distinct from echoed input), and both test terminal and wrapper thread deleted. Receipt: `/tmp/garrison-completed-session-live-check-20260916-dev-madrid.tail31efa.ts.net.json`. No prompt was submitted to the original Cursor session.
