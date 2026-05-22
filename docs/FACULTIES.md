# Agent Garrison Faculties

This document expands the Faculty table from [SPEC.md](./SPEC.md) §2.
The list is a working draft for v1; do not optimize the Faculty set
before the Definition of Done is observable.

## 1. Heartbeat

- Purpose: wake the operative on a cadence and dispatch through the gateway.
- Cardinality: single.
- Shapes: `script`, `skill`, `system-prompt`, `manual-instructions`.
- Config: cadence, jitter, enabled windows, dispatch target.
- Example: loop heartbeat seed with a default 40 minute cadence.
- Failure modes: loop not running, duplicate loops, gateway unavailable, cadence too aggressive.

## 2. Scheduler

- Purpose: handle scheduled work outside the heartbeat cadence.
- Cardinality: single.
- Shapes: `script`, `skill`.
- Config: schedule source, timezone, maximum concurrent scheduled jobs.
- Example: cron adapter or platform-native scheduled task wrapper.
- Failure modes: missed jobs, wrong timezone, overlapping jobs.

## 3. Data Sources

- Purpose: one-way live data fetch from external systems.
- Cardinality: multi.
- Shapes: `mcp`, `cli`.
- Config: source credentials, sync cadence, allowed read scope.
- Example: Trello data source seed.
- Failure modes: expired credentials, rate limits, stale task mirror, source shape drift.

## 4. Knowledge Base

- Purpose: readable reference material such as docs, codebases, and static notes.
- Cardinality: multi.
- Shapes: `skill`, `mcp`, `script`, `cli-skill`.
- Config: index path, refresh cadence, read filters.
- Example: local docs skill, MCP-backed docs search, or the Documents Fitting layered on the Artifact Store.
- Failure modes: stale index, inaccessible path, noisy retrieval.

`cli-skill` is allowed here for Fittings that pair a CLI surface (the
Operative invokes write/read/update commands) with a UI surface (the
user opens documents in a side panel). The Documents Fitting is the
canonical example.

## 5. Automations

- Purpose: actions the operative can take in external UIs or systems.
- Cardinality: multi.
- Shapes: `cli-skill`, `mcp`.
- Config: execution binary, allowed domains/apps, timeout.
- Example: Playwright browser automation seed.
- Failure modes: browser install missing, target UI changed, unsafe side effects.

## 6. Skills

- Purpose: reusable agent skills the Operative can invoke during work — including but not limited to test authoring.
- Cardinality: multi.
- Shapes: `script`, `skill`.
- Config: skill-specific (e.g., test command, coverage target, automation dependency for test-authoring skills).
- Example: an E2E writer skill, a summarizer skill, or any procedure exposed as an APM skill the orchestrator can dispatch to.
- Failure modes: skill mutates user data, side effects bleed across sessions, missing tool dependencies.
- Renamed from `testing-framework` in v1; the parser still accepts the old value with a deprecation warning.

## 7. Memory

- Purpose: within-session and cross-session recall.
- Cardinality: single.
- Shapes: `skill`, `system-prompt`, `hook`.
- Config: recency window, persistence cadence, compiled memory path.
- Example: memory seed that writes a compiled markdown memory file.
- Failure modes: leaking sensitive data, stale memory, conflicting memory stores.

## 8. Classifier

- Purpose: classify prompts and route work through the right execution discipline.
- Cardinality: single.
- Shapes: `skill`, `system-prompt`.
- Config: tier floor, project overrides, reclassification rule.
- Example: tier classifier seed.
- Failure modes: over-classifying trivial work, under-classifying risky work, ambiguous tier output.

## 9. Gateway

- Purpose: MCP-speaking entry point for heartbeat and inbound channels.
- Cardinality: single.
- Shapes: `script`, `manual-instructions`.
- Config: bind host, port, exposure instructions, session endpoint.
- Example: HTTP gateway seed.
- Failure modes: port conflict, public exposure misconfigured, unauthenticated inbound jobs.

## 10. Channels

- Purpose: user-facing message surfaces.
- Cardinality: multi.
- Shapes: `plugin`, `skill`, `script`.
- Config: channel credentials, delivery targets, notification policy.
- Example: Telegram, Discord, Slack, or custom UI channel.
- Failure modes: duplicate notifications, token revocation, channel event replay.

## 11. Observability

- Purpose: health, errors, no-ops, and runtime reporting.
- Cardinality: multi.
- Shapes: `hook`, `script`.
- Config: log sink, alert channel, heartbeat status interval.
- Example: log-tail script or alert hook.
- Failure modes: silent failure, noisy alerts, log sink unavailable.

## 12. Soul

- Purpose: identity, tone, voice, and boundaries.
- Cardinality: single.
- Shapes: `system-prompt`.
- Config: prompt path and optional local overrides.
- Example: local dogfood soul prompt.
- Failure modes: conflicts with orchestrator, accidental policy weakening, identity drift.

## 13. Orchestrator

- Purpose: governing behavior spine and global config owner.
- Cardinality: single.
- Shapes: `system-prompt`.
- Config: projects root, platform, guardrails, permissions mode, observability config.
- Example: v1 single-session orchestrator prompt (no reference Fitting yet — see `fittings/seed/README.md`).
- Failure modes: missing global config, conflicting Fitting instructions, too much hidden behavior.

## 14. Artifact Store

- Purpose: filesystem-backed storage for files the Operative or its Fittings produce — markdown documents, screen recordings, voice audio, generated images.
- Cardinality: single.
- Shapes: `cli-skill`.
- Config: storage root path, optional retention policy hints (v1 has none).
- Example: filesystem artifact store seed under `<composition-dir>/artifacts/` with `documents/`, `automations/`, `voice/` namespaces.
- Failure modes: namespace collision, sidecar drift (file present without `.meta.json`), permissions issues on the storage root, unbounded growth from automation recordings.

## 15. Monitor

- Purpose: read-only visibility into everything Garrison spawns — PIDs, status, ports, network connections, working directory, redacted env, captured stdout/stderr.
- Cardinality: single.
- Shapes: `plugin`, `script`.
- Config: bind port (default `7077`), log retention (default 24 h after PID death), redaction patterns for env keys.
- Discovery: parent-PID descendant walk via `ps -ax`; per-PID details via `ps -o ...` and `lsof -i -P -n`. macOS-first; Linux adapter deferred.
- Log capture: shared spawn helper at `src/lib/spawn.ts` tees stdout/stderr to `~/.garrison/logs/<pid>/`. Processes Garrison did not spawn appear in the card grid via PID observation but have no captured log content.
- Example: `monitor-default` Fitting under `fittings/seed/monitor-default/`, serving its own React UI on port 7077.
- Failure modes: port conflict on the default (Fitting falls back via `findFreePort`), nested-spawn log loss for processes outside the shared helper, stale `~/.garrison/logs/<pid>/` directories.

The Monitor Faculty extends Garrison beyond the original v1 five-kind vocabulary (orchestrator, agent-skill, memory-store, automation-runner, vault). The expansion is recorded in [DECISIONS.md](./DECISIONS.md) (2026-05-16 entry). See [UI-FITTINGS.md](./UI-FITTINGS.md) for the per-Fitting-own-UI-on-own-port pattern the Monitor's default Fitting follows.

## 16. Web channel

- Purpose: mobile-first browser chat surface for talking to the Operative ("Gary") from a phone on the same LAN. Distinct from the desktop Next.js shell; this is the planned successor to the deleted built-in chat.
- Cardinality: single.
- Shapes: `plugin`, `script`.
- Config: bind port (default `7083`), bind host (default `127.0.0.1`; set to `0.0.0.0` to expose to the LAN), optional `gateway_url` override.
- Capability: provides `kind: channel` (`name: web`). The Orchestrator routes to it like any channel — the http-gateway's `POST /chat/stream` is the inbound call, `GET /channels/web/stream` carries replies.
- Streaming: web-channel proxies the gateway's SSE endpoints unchanged. The browser opens an `EventSource` on `/api/stream` for live + last-100-events replay, and `POST /api/chat` to send a turn.
- Monitor link: at runtime, web-channel reads `~/.garrison/ui-fittings/monitor-default.json` to detect Monitor and surfaces a header link if present. No hard `consumes: monitor` — discovery is opportunistic.
- Example: `web-channel-default` Fitting under `fittings/seed/web-channel-default/`, serving its React UI on port 7083.
- Failure modes: port conflict on the default (Fitting falls back via `findFreePort`), `bind_host: 0.0.0.0` exposes the surface to anyone on the LAN with no auth (mirrors gateway posture; documented limitation), one-sided history (channel ring buffer only publishes assistant text events — user turns do not replay), Operative markdown is rendered via `marked` + `dangerouslySetInnerHTML` without further sanitization (acceptable under the single-user trusted-operative posture; flag this when adding multi-user surfaces or untrusted channel inputs).

## Derived: Tasks

Tasks is never selected directly. When a data source declares task
backing, the UI surfaces a derived Tasks status. For v1, selecting
Trello makes Tasks Trello-backed and points at the data source's
declared markdown truth file.
