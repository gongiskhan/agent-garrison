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
