# Mac mini startup recovery — 2026-09-18

The mini's app was reachable, but its composition was idle and its remote-shell observer was absent. The public shell endpoint returned HTTP 502 and Madrid listed seven retained mini sessions as disconnected. Launchd had restarted the app on September 17; the launcher started only Next and the scheduler, without restoring the previously running composition.

## Change

Commits `de19caf6` and `4a77e4bb` add owner-local runtime receipts and a node startup companion. A successful Run records the composition and a generation; an explicit Stop cancels recovery before stopping services. On startup, the companion waits for the app and submits the normal Run request. The runner checks the receipt generation under its operation lock, so Stop or a newer Run wins over an old recovery request. Deployment and Conversation guards defer recovery. The normal state authority, account delivery, install and verification path remains in force; there is no offline secret cache or new shared state store.

The mini's existing launchd job references its checkout through a symlink. The first live restart test exposed that Node resolves the module URL to its real path while argv retains the alias. The companion now resolves its executable path before deciding whether to run. A subprocess regression exercises the actual symlinked entry point.

## Verification

- 40 focused tests pass: seven startup recovery cases, lifecycle and failed-start cleanup, all-fitting startup, and instance isolation. Typecheck and whitespace checks pass.
- Initial availability was restored through the supported fitting start and normal composition Run. All 39 fitting verifiers passed.
- A real 393×852 touch-enabled WebKit journey through Madrid opened the mini's “PoC (se 14:00 api nao)” session, rendered its transcript, opened its shell, and observed the output of a harmless printf. The check removed its own temporary shell and wrapper thread. This is mobile browser evidence, not a physical iPhone claim.

Owner-local deployment, startup and preservation evidence is under the directory named by `/tmp/garrison-mini-recovery-20260918.path` on the mini. Madrid owns the mobile browser receipt at `/tmp/garrison-mini-poc-live-check-20260918-dev-madrid.tail31efa.ts.net.json`. No transcripts or secrets are copied into these notes.

The mini's four pre-existing tracked Cursor edits are preserved byte-for-byte around each guarded deployment, with named recovery stashes retained. Its untracked files are untouched. Source moves only through origin/main.

## Final live result

The mini completed a normal guarded full redeploy of `4a77e4bb`, then a separate guarded supervisor restart at 13:41:56Z. CSG was independently healthy before the restart. The verification did not issue a manual Run afterward. The startup companion restored default at 13:42:20Z and wrote a new running receipt; the fresh supervisor log confirms restoration. By 33.7 seconds of app uptime, the composition was running, all 14 views were healthy and the node was not degraded. The initial symlink failure and manual availability recovery are retained separately from this successful automatic-recovery receipt.

After that restart, both real public HTTPS mobile browser journeys passed: the PoC session rendered one turn, and App Store rejection issues rendered eight. Both opened a visible terminal, produced the actual harmless command marker, showed zero connection warnings, and removed their temporary terminal and thread. Madrid's final session aggregation marks all six current mini rows connected. The observer's five-day retention window determines the current count; no session journal was edited.

Startup receipt: `startup-recovery-verification.json` in the mini evidence directory. The earlier failed launcher-path check is `startup-before-symlink-fix.json`. Browser receipts on Madrid: `/tmp/garrison-mini-poc-live-check-20260918-dev-madrid.tail31efa.ts.net.json` and `/tmp/garrison-mini-app-store-live-check-20260918-dev-madrid.tail31efa.ts.net.json`.

The post-restart observer watch passed 40/40 health requests over 80 seconds, with maximum latency 15.8 ms. Its receipt remains on the mini as `observer-health-after-startup.json`. The mini is serving the rebuilt app and fittings at `4a77e4bb`; the existing phone app needs no update.
