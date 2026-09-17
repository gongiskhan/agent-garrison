# Cursor desktop ingestion validation

Status: Phase 1 implementation and isolated tests pass. Real desktop acceptance
is pending deployment of the revised app bundle. No Phase 1 sentinel is earned.

## Local architecture

The app's existing API on 127.0.0.1:8777 owns the Cursor live journal. The feature
is in `packages/talk/src/cursor/`, mounted by the existing talk router. Direct
hooks use `/api/cursor/hooks/event` and `/api/cursor/hooks/stop`. Every hook
request requires the existing `x-garrison-internal` token. Requests forwarded
from a non-loopback client are refused by the private handler.

The browser's relative `/api/cursor/` read routes relay to the same node's
private API with the token added on the server. The browser receives no token.
Hooks and private routes are not exposed by that relay. No listener or tailnet
serve mapping was added. The existing historical Cursor reader remains intact.

The first live installation attempted to put the new routes on the existing
Shells server. Live requests timed out, and a one-second process sample showed
its history timer doing synchronous directory reads and subprocess waits. That
handler cannot meet the hook response budget reliably. The live ingress was
therefore moved to the app API without changing other runtime listers.

The local journal is append-only and flushed before acknowledgement. It is keyed
by the real node and conversation IDs; filenames use a hash for path safety.
Entries reuse the shared renderer's text, thinking, tool and status blocks.
Complete assistant response text is retained. Tool completions update their
matching start card even when Cursor omits cwd. Repeated thought events with
base and suffixed generation IDs are deduplicated. Live rows supersede historical
rows of the same identity in the browser and are not published to the mesh index.

Settings are in the feature's local directory, following the Shells precedent
of a node-local settings file. The installer uses `~/.garrison/cursor-hook.env`
with mode 0600 and preserves every foreign user hook. It installs only at user
level. The separately measured eight-hour probe process continues running;
its temporary hook configuration has been removed.

## Completed tests

- Fifteen probe tests pass.
- Fifteen ingestion tests pass, including token enforcement, durable recovery,
  event mapping, deduplication, live SSE and fail-open timing.
- Three app relay tests pass, including the actual Node response shim.
- The integration test replayed every real captured Phase 0 payload through an
  isolated authenticated localhost endpoint. Full response text survived.
- The 390 by 844 browser fixture test passes. Its screenshot was inspected for
  visible Cursor, node, workspace, model and Working badges, user origin and
  tool activity. Evidence stays under `test-results/cursor-desktop/` locally.
- The existing shared conversation suite passed fourteen browser tests, and
  twenty journal regressions passed. Type checking passes.

The real desktop journey test is `tests/cursor-desktop-live.test.ts`, enabled
with `GARRISON_CURSOR_LIVE_URL=http://127.0.0.1:8777`. It opens a scratch chat
using the measured native two-Enter path, observes the existing Garrison Shells
UI at phone size, measures prompt latency and verifies full text and tools.
It has not passed yet because the revised production route is not installed.

## Deployment state

The first guarded local reload completed and brought the composition up.
The revised app build compiled and passed type checking, but the immediate
pre-restart guard could not confirm another healthy mesh instance and deferred.
The existing node was preserved. The voice rollout owner is recovering Pro and
will coordinate the next deployment slot. No guard was bypassed.

The installed hook currently targets `http://127.0.0.1:8777/api`. Until the new
bundle is running, its unavailable route fails open. The next step is the guarded
app reload, then the real desktop and phone acceptance test. Steering is Phase 2
and has not started.

## Mesh integration checkpoint — 12 September, 19:23 UTC

The operator requested merging work from Madrid, Pro and Mini into shared main.
Mini's Cursor implementation was reviewed and rebased by a conflict-free main
fast-forward; all existing source changes were retained. The combined tree
passed 34 isolated Cursor tests and TypeScript checking. The captured-payload
replay remains opt-in and was skipped in this run. Real desktop acceptance,
Phase 1 completion and Phase 2 steering remain unclaimed.

The Mini is reachable through SSH, but its desktop session is logged out
(console owner root and no gui/501 launchd domain), so the managed Garrison app
is unavailable. Its canonical checkout is /Users/ggomes/Projects/garrison;
~/dev/garrison is an existing alias. Do not enroll or adopt that alias.
Raw payload reports, screenshots and test-results remain on Mini. Earlier
JSON links in the desktop report refer to these owner-local artifacts.

Latest main contains the separately gated Two Homes activation. Automatic
deployment remains paused while its live model acceptance awaits the prior
scoped credential-delivery approval. No runtime migration or restart occurred
in this integration. The old generated composition export is preserved in a
named mesh-convergence stash, separate from accepted main configuration.
