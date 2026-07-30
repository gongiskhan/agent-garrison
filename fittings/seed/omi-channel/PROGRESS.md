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
