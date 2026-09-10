# Main, mesh availability and connector setup — 10 September 2026

The operator superseded the permanent node-branch policy. All Garrison mesh
checkouts work on `main`; code travels through Git. Existing node commits are
integrated into `main` without discarding uncommitted work. No task or node
branches are created. Shared main is never force-pushed.

Deploy one node at a time, prove it healthy, then proceed. Keep at least one
other healthy instance available. A working Conversation prevents restarting
its owner node; external supervision and stretch handoff do not waive this.
Deferred nodes catch up after work finishes. The common deployment guard checks
durable activity, gateway admissions and a live peer, with a CAS lease in the
shared state service to serialize restarts.

The same request calls for Google OAuth sign-in, a configurable Cortex base URL
defaulting to `https://app.ekoa.io`, useful setup instructions for connectors,
and internal automatic capture credentials with mesh discovery in iOS.
These product changes and their validation are tracked in the roadmap.

Initial migration: `origin/main` fast-forwarded from `58708f8c` to `abf2d106`;
the Pro checkout switched to `main`. Existing connector and voice edits were
preserved. This records Git state, not deployment completion.

## Connector and Capture implementation

Connector status, scoped key writes, OAuth grants and refresh now use the secret
authority on enrolled nodes. Local-only vault reads explained the false missing
Google credentials. Shared grants are encrypted secrets, refresh/connect/revoke
serialize with an authority lease, and a failed authority never falls back to a
node-local credential. Google starts its authorization flow directly.

Connector-owned setup guidance is declared in each manifest. Cortex has a base
URL field on both connector cards, defaulting to the operator-requested
`https://app.ekoa.io`; changing it updates both fitted Cortex consumers through
the composition writer and authority CAS. No client repository or credential
is added to the shipped defaults. The previous no-origin default is superseded
for these two fittings by this explicit request.

Capture credentials are generated internally once and existing credentials are
retained. Delivery uses the same authority for the runner and the phone. Native
URLSession calls `/api/capture/bootstrap` over the node's private HTTPS address;
the route rejects browser-origin/fetch requests and disables caching. Swift
keeps credentials out of the JavaScript bridge, discovers peers in the same
tailnet, preserves offline nodes and the current selection, and refreshes at
launch/foreground and on request. The Capture page has no manual credential or
node-add form; first installation needs only one mesh address.

Pro, Madrid, Air and Mini checkouts have moved to main without runtime restarts.
Connector authority, OAuth route, capture bootstrap, view model, voice resolver,
composition sync and proxy checks pass locally. Native tests and live rollout
remain in progress; source checks alone are not device acceptance.

Live Madrid validation: running default, 43/43 checks, 17/17 views. The Google
button opened Google's account chooser directly using the existing shared
OAuth app; no key form appeared. The native bootstrap derives the actual serve
mapping (Madrid capture is currently 8498), rather than assuming the nominal
8497 mapping. New native tests passed; the initial XCTest suite only failed
the old bridge method-count expectation, now updated for refresh.

Completed rollout: all five checkouts use main with automatic catch-up installed.
All four primary nodes pass 17/17 service checks and native Capture bootstrap;
CSG's smaller local composition passes 9/9 after its authority connection was
recovered. Its existing public tether and absent Capture fitting remain separate
availability limits. Native XCTest passed 122 tests and TestFlight build39 was
uploaded. See `docs/validation/2026-09-10-main-connectors-capture.md` for exact
evidence, live lease contention, upstream Cortex 404 and the remaining phone gate.
