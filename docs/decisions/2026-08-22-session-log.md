# Append-only session log — the Harness Ideas Adoption Brief, implemented

**Date:** 2026-08-22
**Source:** "DeepSeek Harness vs. Agent Garrison" research report (Aug 2026);
the adoption brief's seven decided topics.

## What shipped (v1, deliberately small)

- **Substrate**: `packages/claude-pty/src/session-log.mjs` — one JSONL per
  Operative run under `$GARRISON_HOME/session-logs/`, append-only, seq-resuming
  across reopen, shadow-don't-delete (`shadowOf`), payloads capped with an
  explicit truncation marker. Schema is runtime-neutral (topic 6): `{v, seq,
  ts, run, domain, turn, kind, runtimeSessionId?, shadowOf?, payload}`.
  Domains (topic 4): session/agent/tools/channel/automation/api/lifecycle —
  only `session` feeds prompt derivation. Single-writer: the gateway process
  owns the file; in-process runtime adapters share the module singleton via
  `runLog()` (`GARRISON_SESSION_LOG_RUN`, set at gateway boot).
- **Choke point**: the Agent SDK adapter logs every COMPLETE SDK message
  (assistant/user → session; result/system → agent; compaction boundaries →
  session, kind `compaction`) before processing, in both the standing and
  one-shot lanes; `stream_event` deltas are skipped by design. Every injection
  (`sendTurn`) is an event before it is a prompt. The gateway wraps
  `runRoutedTurn`: channel-domain inbound/outbound/turn-error per exchange,
  turn ids stamped from day one (`<threadId>#<turnSeq>` where known).
- **Viewer**: `GET /api/session-log` (+ per-run event pages) and a
  SessionLogPanel on the dashboard beside the Run console — runs list, domain
  filter, expandable payloads. Renders nothing until a log exists.
- **Logging proxy** (topic 2): `http-gateway/scripts/lib/anthropic-log-proxy.mjs`,
  opt-in via the fitting's `session_log_proxy` config. Loopback proxy the
  Anthropic-bound SDK spawns dial (`ANTHROPIC_BASE_URL`); records literal
  request/response as api-domain events, credentials REDACTED in the logged
  copy, streaming passthrough so capture never delays a turn.
- **Hardening** (topic 7): the gateway refuses browser cross-origin requests —
  an Origin header that is not the gateway's own origin is rejected unless the
  request carries `x-garrison-token` (minted once at
  `$GARRISON_HOME/gateway-token`, 0600 — unreadable to a webpage). Loopback
  server-to-server Node clients send no Origin and are untouched.

## Explicitly not done, per the brief

- Resource ledger (topic 5): the remote-shell fitting runs OUT of the gateway
  process — writing its acquisitions into the run log would need a second
  writer or an RPC hop, i.e. not free. Skipped entirely, as instructed.
- basic-memory unchanged (topic 3). No dsh-runtime work (topic 6). No restart
  loops, no Programmatic Tool Calling, no native Garrison runtime (rejected).

## Open question, unchanged

Per-run files with a shared schema (current) vs one stream per instance —
revisit when cross-run search or the improver's consumption gets awkward.
