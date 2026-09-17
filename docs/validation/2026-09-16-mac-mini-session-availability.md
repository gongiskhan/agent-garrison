# Mac mini session availability — 2026-09-16

The user's Madrid Conversations view showed the Mac mini's “App Store rejection issues” Cursor session offline, with its transcript stuck connecting and Open shell disabled.

## Findings and correction

The Mac mini app was reachable, but its composition was idle, no own-port views were running, and the session observer status file was absent. Normal guarded startup restored the composition at 21:14:31Z; all 39 fitting verifiers passed. That recovered session viewing and shell access initially, but subsequent checks still intermittently marked the observer unavailable.

The observer process remained alive. Its health endpoint took 3.32 seconds while synchronous session discovery ran on the HTTP thread. Cursor metadata reads repeatedly hit their five-second timeout against the owner's roughly 1.4 GB database. Thus an expensive local scan blocked health checks and terminal traffic, causing false offline reports. The original reason the composition was stopped is not established by this evidence.

Fix `9b055dea`, with worker lifecycle follow-up `3fac512d`, runs discovery in one persistent worker, with coalesced requests, a bounded build deadline, failure recovery, and explicit shutdown. Only plain owned-session row metadata crosses into the worker; PTYs and sockets stay with the server. The last successful index remains available during scanning or failure, and persistent lister caches survive refreshes. Cursor metadata extraction now parses all six requested fields together instead of issuing a separate extraction per field. A read-only measurement on the actual database completed in 3.7 seconds with 52 metadata rows and 6.8 KB output; no conversation bodies were selected or copied.

## Verification

- 45 scanner, worker and origin-guard tests pass. The new real-server regression blocks SQLite while proving startup, health and cached-index responses remain available; it also covers worker timeout/recovery and transfer of owned rows with non-cloneable live session handles excluded. A standalone-process regression ensures a pending discovery retains the worker until its result arrives.
- 17 terminal runtime and mesh-session tests pass; two existing SSH-dependent integration cases skip in this environment.
- Typecheck, syntax checks, whitespace checks and the fitting's declared read-only verifier pass.
- The Mac mini's four pre-existing tracked edits remain byte-identical to the backup; its unrelated untracked files remain present. Source moves through git on main. The observer uses the supported fitting restart under the Conversation and mesh deployment guard; the app process and desktop Cursor are not restarted for this code change.

The owner recovery directory is named by `/tmp/garrison-mini-session-recovery-20260916.path` on the mini. It contains the original tracked diff/status and operational receipts. The app's existing built bundle is `b9e9c3a5`; this change reloads the observer from the updated committed source, and does not claim a full app rebuild over the mini's unrelated working changes.

## Live completion

The guarded, supported observer restart completed at 21:35:42Z after CSG's sequential automatic rollout released the mesh lease. The first immediate post-restart probe raced the new listener and was refused; the service then came up normally without another restart. The mini's new observer runs source `3fac512d`; the app and Cursor desktop stayed running.

At 21:37:38Z all 40 one-second-spaced health samples succeeded across five distinct index refreshes. The slowest health response was 14.9 ms, compared with the 3.32-second blocked response before the fix. The index contains 12 sessions and the target retains its saved title with idle status. `/api/mesh/self` reports the composition running, 14/14 healthy views and `degraded: false`. The four pre-existing tracked changes still match the original byte-for-byte patch.

Public HTTPS WebKit verification through Madrid at 393×852 opened the exact mini session shown in the user's screenshot, rendered eight transcript turns, opened its shell, and verified a harmless command's actual terminal output. There were zero connection warnings. Both the temporary terminal and its wrapper thread were removed. The browser receipt stays on Madrid at `/tmp/garrison-mini-session-live-check-20260916-dev-madrid.tail31efa.ts.net.json`. On the mini, the recovery directory contains `observer-restart.json`, `observer-latency-after.json` and `health-after-fixed.json`.

Madrid remained running with 14/14 healthy views. CSG completed its automatic rollout of `3fac512d`, with the composition running since 21:33:53Z and 9/9 healthy views. No claim is made here about a new iOS build or a full mini app rebuild; neither is needed for this observer repair.
