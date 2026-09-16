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
