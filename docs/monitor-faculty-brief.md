# Brief: Monitor Faculty for Garrison

## Context

A core Garrison premise is full visibility of what's happening. The desktop logs aren't enough once we start spawning multiple sessions, subprocesses, and servers from the orchestrator. We need a unified, observable, drill-into-able view of **everything Garrison spawns** — sessions, child processes, servers, the lot — accessible from any channel (web, desktop, future surfaces).

This brief introduces a new **Monitor Faculty**, distinct from the existing Faculties (Gateway, Channels, Memory, Skills, Orchestrator), and a default Fitting that implements it with its own UI.

## Why a Faculty (not just a web channel feature)

Session and process visibility isn't a UI concern; it's foundational platform behaviour. The web channel is one consumer; the desktop shell will be another; a CLI inspector might be a third. The Faculty owns the data; consumers pick it up.

## Scope

The Monitor Faculty:

- Tracks all entities Garrison spawns: orchestrator-created sessions, child processes, servers, anything reachable from Garrison's process tree.
- Captures per-entity: PID, command, status, start time, uptime, parent/child PIDs, open ports, active network connections, working directory, environment, resource usage, and stdout/stderr logs.
- Detects death/exit and updates status accordingly (no orphans showing "running" forever).
- Exposes an API for any consumer to query state, subscribe to live updates, and fetch logs.
- Ships with a default Fitting that **also** serves its own UI (the Monitor UI) on its own port.

## Out of scope (do not build now)

- Acting on processes (kill, signal, pause) — read-only for now.
- File-system artifact browsing — comes later when the file Faculty exists.
- Multi-host / remote monitoring.
- Historical analytics, dashboards, alerting.
- Sending input *into* a running session (the chat channel handles dialogue with the orchestrator; the monitor is observational).

## Architecture

### Discovery model

Primary mechanism: **parent PID observation**. Garrison knows its own PID; everything it spawns is in the descendant process tree. Walk that tree using standard Unix tools (`ps`, `lsof`, `/proc` on Linux, equivalents on macOS) to discover children, their ports, network connections, working directories, and resource usage.

This sidesteps the "did the process remember to report it stopped" problem — Garrison just observes.

### The open feasibility question

Process tree observation is clean for *direct* spawns. Nested spawns are trickier — if Gary spawns a Claude session, and that session spawns a node server, can Garrison still observe the server's stdout? The PID tree shows it, but log capture requires having the stream handle at spawn time.

**Claude Code should investigate as Phase 1:**

- What's reliably observable cross-platform via PID alone (ports, network, cwd, env, uptime, status) vs. what needs a spawn-time hook (stdout/stderr capture)?
- Can Garrison wrap process spawning at a low enough level (e.g., a shared spawn helper used by all Fittings) to tee logs to disk for any descendant?
- Fallback: a lightweight convention where spawned processes write to a known log directory under `~/.garrison/logs/<pid>/`.

Document findings in `DECISIONS.md` before implementing capture.

### UI Fitting pattern (lock this in across Garrison)

**Each UI-bearing Fitting serves its own UI on its own established port.** Other Fittings reference it by URL, not by importing components or sharing state. This is the canonical pattern for Garrison.

Why: it minimises coupling. A consumer Fitting doesn't need to know about another Fitting's backend, state, or framework — just its port. If the Fitting is wired in, its URL works. If not, it doesn't. That's the whole contract.

This applies to:

- The existing **`web-channel`** Fitting (serves its own chat UI on its own port).
- The new **`monitor`** Fitting (serves its own Monitor UI on its own port).
- All future UI Fittings.

Document in a new `UI-FITTINGS.md` (or section in existing docs).

### Monitor UI

React, bundled with esbuild, same approach established for `web-channel`. No `node_modules` in the Garrison repo — UI source in `fittings/monitor/ui/`, build artefact in `fittings/monitor/dist/`.

**Layout (responsive):**

- Desktop: card grid.
- Mobile: cards stacked single-column.

**Card (per spawned entity):**

- Status indicator with motion — spinner if active, pulse if waiting, solid if idle, neutral if done, red if failed.
- Short label (command summary or session name).
- PID.
- Uptime.
- Open ports rendered as clickable links (`http://localhost:<port>`).
- Brief resource snapshot (CPU / memory) if cheap to collect.

**Drill-down (panel, not modal — user preference):**

- Full command line.
- Working directory.
- Environment variables (collapsed by default; expand on demand).
- All open ports.
- Network connections — listening *and* active outbound.
- Process tree — parent and children, each clickable to drill into.
- Start time, uptime, resource usage.
- **Log viewer:**
  - Scrollable, tails new output in real time via SSE.
  - Toggle between stdout, stderr, or combined.
  - Timestamps on each line.
  - Basic search/filter if cheap to add.

**Process tree visualization:** collapsible tree of parent-child relationships, with each node linking to its drill-down panel.

### Web channel integration (optional consumption)

The `web-channel` Fitting declares **optional** consumption of the `monitor` capability:

- On load, the web channel performs a lightweight availability check against the Monitor Fitting's known port (simple `GET /health` or equivalent).
- If reachable: web channel shows a "Monitor" button/link in its UI.
- If not reachable: button is hidden.
- Clicking the button opens the Monitor UI. Default: new tab/window on desktop, full-screen overlay panel on mobile (mobile back button returns to chat). Implementation detail — Claude Code to choose what feels best.

The web channel does **not** embed the Monitor's React components or share its state. It only links to the Monitor's URL. This honours the per-Fitting-own-UI-on-own-port pattern.

## Capability kind and Faculty additions

- Add `monitor` as a new Faculty in Garrison's Faculty list (alongside Gateway, Channels, Memory, Skills, Orchestrator).
- Add `monitor` as a new capability kind for the runtime `provides` / `consumes` vocabulary.
- Note: this expands beyond the original v1 five-kind vocabulary. Given that v1 isn't releasing and scope is "whatever is useful," this is acceptable. Record the expansion explicitly in `DECISIONS.md`.

## Implementation phases

### Phase 1 — Feasibility audit

1. Survey cross-platform PID observables on Linux + macOS (`ps`, `lsof`, `/proc`, `netstat`, `pgrep`, equivalents).
2. Determine log capture strategy for direct spawns and nested spawns. Decide between spawn-wrapping, sidecar logging convention, or hybrid.
3. Decide on Monitor Fitting's well-known port and document the UI-Fitting port allocation convention.
4. **Verify:** a throwaway script that spawns a child process which opens a port, and a CLI command that prints all observables Garrison can collect for that PID. Output matches reality.

### Phase 2 — Monitor Faculty backend

1. Define the Faculty contract: list entities, get entity by PID, subscribe to live updates (SSE), fetch logs (paged + tailed).
2. Implement the default Monitor Fitting:
   - Process tree walker (periodic poll, e.g. 1s, plus event-driven updates where cheap).
   - Log capture for processes spawned via Garrison's spawn helper (Phase 1 decision).
   - Status transitions on exit detection.
3. Register the Fitting with Garrison so `apm install` wires it.
4. **Verify:** spawn 2–3 test processes via Garrison; query the Monitor API; see them tracked with correct PID, ports, uptime, status. Kill one; status flips to exited within one poll cycle. Logs from a known-output process are captured and retrievable.

### Phase 3 — Monitor UI Fitting

1. `fittings/monitor/ui/` workspace with `package.json`, React, esbuild — isolated from Garrison core.
2. Build produces `fittings/monitor/dist/{index.html, monitor.bundle.js, monitor.css}`.
3. Tiny Node service serves `dist/` statically and proxies the Faculty API endpoints + SSE.
4. Implement card grid, drill-down panel, log viewer, process tree.
5. Mobile-responsive layout.
6. **Verify:** open the Monitor UI URL on desktop — cards render, click one, panel opens, logs stream live, port link works. Open same URL on mobile — layout stacks cleanly, drill-down panel is usable on a phone.

### Phase 4 — Web channel integration

1. Update `web-channel` to declare optional `consumes: monitor`.
2. Add availability check on web channel load (lightweight ping to Monitor's known port).
3. Conditionally render a "Monitor" button/link in the chat UI.
4. Wire the button to open the Monitor URL (new tab on desktop, overlay panel on mobile).
5. **Verify:** with Monitor wired in, web channel shows the button and clicking opens the Monitor UI. With Monitor not wired in, button is hidden. Switching between chat and Monitor feels seamless on mobile.

## Decisions to lock in (record in `DECISIONS.md`)

1. Monitor Faculty added to Garrison's Faculty list.
2. `monitor` added as a new capability kind, expanding beyond the original v1 five-kind vocabulary.
3. Parent PID / process tree observation is the primary discovery mechanism.
4. Each UI-bearing Fitting serves its own UI on its own established port — canonical Garrison pattern.
5. Cross-Fitting UI integration is via URL link to known port, not component sharing or state passing.
6. Optional capability consumption pattern (web channel → monitor) — consumer performs an availability check and degrades gracefully.

## Documents to create/update

- `CAPABILITIES.md` — register `monitor` capability kind.
- `UI-FITTINGS.md` (new, or section in existing) — the per-Fitting-own-UI-on-own-port pattern, including build (esbuild + React) and port allocation convention.
- `DECISIONS.md` — entries for the items above.

## Open questions for Claude Code to confirm before coding

1. Cross-platform PID observable surface — what's reliably available on both Linux and macOS, what's not?
2. Log capture strategy — wrap spawn, sidecar convention, or hybrid? Decision needs to land in Phase 1.
3. Port allocation convention for UI Fittings — fixed per Fitting, config-declared, registry-assigned? Pick one and document.
4. Availability check mechanism for optional consumption — simple HTTP ping to known port, registry query against Garrison's wiring graph, or both? Pick the simplest workable option.
5. Monitor UI launch behaviour from the web channel — new tab, overlay panel, both depending on viewport? Pick a default; the brief is OK with implementation discretion here.
