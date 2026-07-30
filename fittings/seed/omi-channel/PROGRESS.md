# Omi channel — build progress

Milestones per the implementation spec (M0-M7). A milestone is done only
with green tests and an entry here.

## M0 — Recon and scaffolding (2026-07-30)

Shipped:
- Recon of all six required subsystems (channels contract, notifications,
  kanban heartbeat, orchestrator interface, config/secrets, scheduling)
  plus public-ingress options and memory/metrics conventions; placement
  decisions recorded in `docs/adr-omi-channel.md`.
- All five external doc surfaces fetched and verified; shapes recorded in
  `docs/omi-api-notes.md` (two spec refutations found: `speakerId`
  camelCase; notification API is uid+message query params).
- Fitting scaffold: `apm.yml` (faculty channels, own_port 7094, provides
  channel/omi, vault secret_scope, every pipe a default-off boolean flag),
  `lib/config.mjs` (env-only config, no port literals), `scripts/start.mjs`
  + `scripts/server.mjs` (status file, /health, status page, `/omi/*`
  ingress routes answering 501), `scripts/omi.mjs --probe` verify hook,
  non-blocking `scripts/setup.sh`.
- Registered in `data/library.json` and stationed in the default
  composition's channels selection (config all-off).

Deviations: see `DECISIONS.md` (notifications-fitting absence, scheduler
job instead of kanban tick patch, uid pin location, speakerId, uid+message
notification params).

Next: M1 — ingress auth (?key= + uid pinning), async enqueue + capture_event
normalization with dedupe, fixtures from the verified shapes, replay
harness.

## M1 — Ingress and normalization (2026-07-30)

Shipped:
- Auth on every `/omi/*` route: `?key=` shared secret compared via
  fixed-length digest `timingSafeEqual`, uid pinned on first authenticated
  call (`state.json`), foreign uid and wrong key rejected AND counted;
  master `enabled` flag off = 403 on everything (I8/I9).
- Fast-ack ingress (I7): raw payload enqueued to `raw-queue/` in one small
  file write, 200 returned, normalization on a serialized drain chain;
  leftover queue drained on boot (crash recovery).
- `lib/normalize.mjs`: conversation + day-summary -> source-agnostic
  `capture_event` (I2), `summary_json` only, transcript flattened to
  "Speaker: text" prose; `lib/store.mjs`: file-per-event store, dep-free
  ulid, atomic writes, per-writer counters.
- Two-layer dedupe (I6): raw-body fingerprint (covers malformed payloads
  too) + semantic key (omi conversation id / day date); replaying the whole
  fixture set twice is byte-identical inbox state, asserted in tests.
- Realtime pipe: counted, parsed in memory, NEVER persisted or logged with
  content (I5); wake gate lands in M4.
- Fixtures (duplicates, content drift on the same conversation id,
  discarded, PT-only, mixed PT/EN multi-speaker, day summary, malformed
  JSON, realtime segments) + `scripts/replay.mjs` harness (`--twice`).
- Tests: `tests/omi-channel-ingress.test.ts` (10) covering all M1
  acceptance criteria; M0 test updated (disabled ingress = 403, not 501).

Deviations: none new (403-when-disabled was already recorded in
DECISIONS.md).

Next: M2 — heartbeat triage: omi-triage scheduler job, rule filters, ONE
batched gateway model call per non-empty tick, card/memory/tip candidates,
board dedupe by origin_id, zero-model-call empty tick asserted.
