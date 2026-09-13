# Messages store validation

Date: 2026-09-13. Evidence owner: goncalos-macbook-pro.

The state migration adds relational Messages tables and FTS5 without changing existing state APIs. The client schema maximum advances to 3. Schema 3 explicitly retains a compatibility floor of 2, allowing existing schema-2 nodes to read and write during the sequential rollout. Tests exercise old and new client writes and reject incompatible clients. The ingestion token is scoped to its 90-second lease and fenced on every atomic message/cursor batch.

The foundation test run passed 78 tests across six files: store 12, system producers and actions 33, real answer journey 1, restricted worker 26, callback discovery and handover 2, media 4. The real API journey also passed in both Playwright profiles. It emits a question, queries Needs me, delivers the answer through the existing HTTP conversation path, and checks exactly one durable user signal. Browser reports are in evidence/messages/p1; the lead visual verdicts are in evidence/messages/vision-checklist.md.

Provider read modules are included as runtime dependencies. Their complete UI and live-provider acceptance gates remain separate phases. Google mail consent and Slack user setup are pending. Fixtures contain invented content only.

Runtime startup uses the shell instrumentation hook, so persisted notification mirrors and provider ingestion do not depend on visiting Messages. The demo callback is available only in explicit fixture mode and is refused in production. New callback providers use the same descriptor registry and restricted read transport.

The old WhatsApp outbox remains the hold authority. File metadata records its owner, and attachments retain generated playback, thumbnails and transcripts across provider state refreshes and ingest lease handover. Binaries remain outside SQLite.
