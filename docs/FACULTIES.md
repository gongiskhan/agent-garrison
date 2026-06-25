# Agent Garrison Faculties

## Current model: 9 roles (Quarters pivot, the 2026-06-18 sessions split, the 2026-06-22 modes faculty)

Faculties are now **roles only**. The flat 24-Faculty list was collapsed to six
roles in the 2026-06-07 Quarters pivot; on 2026-06-18 the overloaded `sessions`
role was split into three (sessions / runtimes / surfaces), bringing the total
to eight; `modes` was added 2026-06-22 (the Gary/Joe/James identity layer),
bringing it to nine, enforced by `facultyIds` in `src/lib/types.ts`:

- **orchestrator** — the governing behaviour spine; projected to
  `~/.claude/rules/garrison-orchestrator.md` as an APM instructions primitive
  (the Operative folded into the user's real Claude Code).
- **channels** — user-facing message surfaces (Slack, web-channel, …).
- **gateway** — the MCP/HTTP entry point inbound channels and runtime route to.
- **runtimes** — alternative execution engines behind the uniform runtime
  bridge: Agent SDK, Codex, Gemini. The composition names one primary; others
  are secondary `delegate()` targets the Orchestrator routes work to. Split out
  of `sessions` on 2026-06-18.
- **memory** — within-session and cross-session recall; a plain-markdown
  Obsidian vault indexed into a local SQLite knowledge graph (Basic Memory),
  with write/search/read tools shared across runtimes. Since 2026-06-10 it also
  holds external data sources (trello-data-source, revived with the
  `data-source` capability kind); `data-sources` is a deprecation alias for it.
- **observability** — health, logs, runtime reporting (the read-only Logs view).
- **sessions** — the working dev session and its records, headlined since the
  2026-06-11 Dev Env consolidation by the **dev-env** Fitting: a tabbed surface
  where each Claude Code session gets a Claude PTY + shell PTY alongside a live
  browser pane, with worktrees and session status built in. The artifact store
  backs it.
- **surfaces** — the auxiliary own-port live viewers split out of `sessions` on
  2026-06-18: screen-share, the standalone browser, and remote Outpost bridges.
  Each is detected via the `own_port` flag and linked from the sidebar Views
  group. `screen-share`, `browser`, and `outposts` are deprecation aliases for
  this role.
- **modes** — the operative's identity/persona layer (added 2026-06-22): the
  souls (Gary/Joe/James), the shared voice, the per-mode routing bias, and
  name-based mode switching, composed into the orchestrator's system prompt.
  One operative, three faces, one shared memory. Provided by the `modes` Fitting
  and consumed by the orchestrator.

## Optional capability faculties (2026-06-24)

The 2026-06-24 wave promoted the Claude Code primitives — what were surfaced as
a separate "Claude Code components" group (skills, hooks, agent tools/MCPs,
plugins) — into **first-class Fittings**. The primitive type survives only as an
internal `component_shape`; users never compose a "skill" or an "MCP", they
station a Fitting into one of these purpose-named **optional capability
faculties**. Each is named for what the capability is *for*, never the primitive
behind it, and carries a display **tier** — `agent` (everyday base operative) or
`dev` (only relevant while doing development work, anchored on the modes config:
the dev mode, Joe, is what activates the dev-tier faculties). The tier is
orthogonal to essential/optional and only drives the Compose grid's two headers.

Agent-tier (everyday):

- **knowledge** — create, edit, and organize documents and notes (office files,
  vault notes, generated reports) and pull facts back out of them.
- **research** — find things out and make sense of media: research a question
  across sources, watch and summarize a video, consult reference material.

Dev-tier (development work):

- **building** — write, test, and ship software end-to-end: plan, implement,
  prove it works, record the evidence.
- **code-intelligence** — understand and navigate a codebase: find where things
  are defined and used, read structure without trawling files by hand.
- **design** — design and prototype user interfaces: explore visual directions,
  build hi-fi prototypes, review the result for polish.
- **browser-qa** — drive a real browser to build and verify: click a flow, fill
  forms, read the console, confirm a change actually works.
- **coordination** — keep parallel work sessions out of each other's way: claim
  files, plan before touching shared structure, pass messages between sessions.

These faculties are populated by **discovery-driven projection** (the Quarters
StateModel mirrors the live `~/.claude`; promoted primitives appear under their
faculty with an authored description + contract + editable setup instructions) in
the **Hybrid** model — a few genuinely general units also ship as real
`fittings/seed/` packages. See
[`/FITTINGS_MIGRATION_PLAN.md`](../FITTINGS_MIGRATION_PLAN.md).

---

Everything that used to be its own Faculty — Skills, Hooks, MCPs, Plugins,
Scripts, Settings, Context, Plans — is now a **Quarters platform primitive**, not
a Faculty (see [`decisions/2026-06-07-faculties-as-roles-operative-folded.md`](./decisions/2026-06-07-faculties-as-roles-operative-folded.md)).
The own-port runtime residue (dev-env, screen-share, outposts, browser,
monitor, web-channel, voice) survives under
`sessions`/`surfaces`/`channels`/`observability` via the metadata `own_port`
flag, not as selectable faculties. Legacy faculty names are accepted as
deprecation aliases. The sessions split is recorded in
[`decisions/2026-06-18-sessions-split-runtimes-surfaces.md`](./decisions/2026-06-18-sessions-split-runtimes-surfaces.md).

---

## Historical: the retired flat-Faculty model

The sections below describe the **previous** flat-Faculty model. They are kept
for the long-form intent and failure-mode notes (still useful for the surviving
own-port Fittings), but the named faculties below — except the six roles above —
are no longer selectable; they fold into the roles via aliases.

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
- Config: recency window, persistence cadence, vault path.
- Example: `basic-memory` seed backed by a plain-markdown Obsidian vault indexed into a local SQLite knowledge graph.
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

## 17. Browser

- Purpose: headless browser substrate Garrison owns and exposes over HTTP/WS. Hosts a Playwright-launched Chromium, streams per-tab JPEG screencast, dispatches mouse/key/touch input, and reverse-proxies Chromium's built-in DevTools so iPad Safari over Tailscale gets the full Chrome DevTools UI. Targets two consumers: the Dev Env Fitting's per-session browser pane (the successor to the retired terminal Fitting's split-pane, which replaced its old `<iframe>` pointed at the user's dev server) and future Operative-side Fittings that want to drive a browser via raw CDP.
- Cardinality: single.
- Shapes: `plugin`, `script`.
- Config: bind port (default `7084`), bind host (default `127.0.0.1`; set to `0.0.0.0` to expose over Tailscale), viewport dimensions (default `1600x1200`), JPEG quality (default `70`), `every_nth_frame` (default `1`).
- HTTP endpoints: `GET /health`, `GET /tabs`, `POST /tabs {url}`, `POST /tabs/:id/nav {url}`, `POST /tabs/:id/{back,forward,reload}`, `DELETE /tabs/:id`, `GET /devtools/*` (reverse-proxy to Chromium's rdp HTTP server — serves the official `inspector.html` and asset bundles), `GET /canvas/:tabId` (HTML page: `<canvas>` + URL bar + DevTools button), `GET /` (tabs list / + new tab).
- WS endpoints: `/viewport/:tabId` (Garrison-viewport-v1: JSON `{type:"frame", b64, meta}` + client ACKs), `/input/:tabId` (Garrison-input-v1: `mouse|key|touch|wheel|insertText`; server emits `{type:"focusedField", editable}` to drive iPad hidden-input focus), `/cdp/:tabId` (raw CDP passthrough to Chromium's per-target WS).
- Open DevTools: `<fitting-url>/devtools/inspector.html?ws=<fitting-host>:7084/cdp/<tabId>` — Chromium serves the full DevTools frontend (loaded from `chrome-devtools-frontend.appspot.com`), and the CSP allows same-origin WS, so the connection through `/cdp/<tabId>` works over Tailscale.
- Example: `browser-default` Fitting under `fittings/seed/browser-default/`, serving its React UI on port 7084.
- Launch detail: Playwright's `chromium.launch()` uses chrome-headless-shell with `--remote-debugging-pipe`, which does not expose Chromium's HTTP CDP server. The Fitting spawns the full Chrome-for-Testing binary directly via `child_process.spawn` (`chromium.executablePath()` returns the right binary) with `--headless=new --remote-debugging-port=<picked>`, then attaches Playwright via `chromium.connectOverCDP`. v1 supports one viewer per tab; a second `/canvas/:tabId` viewer detaches the first's screencast.
- Failure modes: port conflict (fallback via `findFreePort` on both the fitting port and Chromium's rdp port), missing full Chromium binary (setup runs `npx playwright install chromium`; override via `BROWSER_CHROMIUM_PATH`), CSP blocking the DevTools WS (mitigated by `--remote-allow-origins=*`), iOS Safari background-tab WebSocket drop (mitigated by client `visibilitychange` reconnect), DevTools frontend CDN unreachable (clients without internet won't load `inspector.html`'s scripts — a vendored alternative is v2 work).

## Derived: Tasks

Tasks is never selected directly. When a data source declares task
backing, the UI surfaces a derived Tasks status. For v1, selecting
Trello makes Tasks Trello-backed and points at the data source's
declared markdown truth file.
