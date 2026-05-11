# Phase 6 Execution Plan — Outposts

**Companion to:** `GARRISON_ROADMAP.md` — Phase 6 section. The
roadmap is source of truth for *why*; this doc is source of truth
for *what next*.

**Phase 6 outcome (from roadmap):** Garrison gains an `outposts`
Faculty. A small `garrison-outpost-bridge` process runs on each
remote Mac. From a single Operative on the host, Garrison can
spawn worktrees, run terminals, execute commands, watch files,
and route Operative actions across N machines connected via
Tailscale.

**Status going in:** Phases 1-5 complete (Phase 5 just landed).
Armory's worktree-management, terminal, session-view Fittings work
locally. Phase 6 extends them with outpost-awareness.

**Important framing:** Phase 6 is a *platform* phase — it adds a
new transport layer and a new family of Faculties. The work is
mostly protocol design, bridge implementation, host-side Fitting,
and integration into existing Armory Fittings. Less UI, more
infrastructure.

---

## Pre-agreed: T0 is a protocol design session

The roadmap calls out multiple open questions that need settling
before code is written:

- Protocol shape (JSON over WebSocket vs gRPC vs custom binary).
- Message framing details.
- Auth model (token, rotation, lifecycle).
- Reconnect strategy (timing, state recovery on reconnect).
- Multiplexing strategy (shared connection vs per-consumer).
- Failure semantics per operation type.

These are decisions, not investigations — but they need to be made
before any other ticket touches code. T0 produces
`PHASE_6_PROTOCOL.md` committed to the repo. Subsequent tickets
reference it for the wire format and contract semantics.

---

## Cross-phase notes before we start

**1. The bridge is its own deliverable in its own repo.** Like the
memory-compiler, `garrison-outpost-bridge` lives in its own
GitHub repo and is cloned to remote Macs by a bootstrap script.
The Garrison repo references the bridge repo but doesn't bundle
it. This matches the memory-compiler precedent and keeps the
bridge install per-machine without conflating it with the host's
Garrison install.

**2. SSH is used for bootstrap only.** Once the bridge is up,
*all* traffic flows through the WebSocket. SSH remains in the
toolchain because the bridge install one-liner uses it (or curl-
pipe-bash if the user prefers), but Phase 6 is not building "more
SSH-driven features."

**3. The Operative-side bridge usage is the design-now-cost-zero
payoff.** The bridge protocol already supports `exec`, `fs`,
`process` operations because the Armory needs them. Wiring them
to an Operative-callable skill is a small additional Fitting
that reuses what already works. Phase 6 ships this Fitting — it's
the "Operative can act on any machine" deliverable.

**4. Vault sync is a real user need, not a nice-to-have.** The
Obsidian vault going out of sync across machines is a daily pain.
v1 ships unidirectional sync (host → outposts) which solves the
"my notes are stale on Mac 2" problem. Bidirectional is
acknowledged as harder and deferred.

**5. macOS-only for v1.** All three of the user's machines are
Macs. Linux/Windows bridges are a future concern.

---

## Ordering & dependencies

```
T0: Protocol design                                ── must come first
T1: garrison-outpost-bridge repo + minimal daemon  ── needs T0
T2: outpost:tailscale-host host-side Fitting       ── needs T0 + T1
T3: Bootstrap flow (token, install, registration)  ── needs T1 + T2
T4: Armory integration: terminal w/ outpost        ── needs T2
T5: Armory integration: worktree-management        ── needs T2 + T4
T6: Armory integration: session-view               ── needs T2 + T4 + T5
T7: outpost-actions agent-skill Fitting            ── needs T2
T8: vault-sync Fitting                             ── needs T2
T9: Phase 6 verification                           ── all
```

T0 unblocks everything. T1 + T2 together form the minimum viable
bridge (one machine connected, no useful operations yet). T3 makes
the bridge installable on a fresh Mac. T4-T6 retrofit Armory.
T7 unblocks Operative-side use. T8 is the first non-Armory
consumer of the bridge.

Parallelism after T0: T1 and T2 can run in parallel (the protocol
is settled; bridge and host-side implement it independently). T4
through T8 can all run in parallel once T2 lands.

---

## Tickets

### T0 — Protocol design

**Why:** Every subsequent ticket needs a settled wire format and
contract semantics. T0 is a one-day design exercise producing
`PHASE_6_PROTOCOL.md`.

**Scope:**

- **Transport:** WebSocket over Tailscale. Confirm vs gRPC. Lean
  WebSocket — JSON debuggability, no proto compilation step,
  cleaner reconnect semantics.
- **Message framing:** every message is a JSON object with
  `{version, type, id, payload}`. `type` is the operation or
  event name. `id` correlates requests to responses (RPC-style)
  and is unused for events (bridge-initiated push).
- **Versioning:** every message carries `version: 1`. Bridge and
  host check on handshake; mismatch refuses the connection with
  a clear error. Updates to v2 require both sides to update.
- **Operation namespaces:** define the exact list for v1. Group:
  - `process.spawn`, `process.kill`, `process.send_input`,
    `process.list`, `process.status`
  - `fs.read`, `fs.write`, `fs.list`, `fs.exists`, `fs.mkdir`,
    `fs.delete`, `fs.watch`, `fs.unwatch`
  - `git.list_worktrees`, `git.create_worktree`,
    `git.delete_worktree`, `git.status`
  - `exec.run` (one-shot, returns full output),
    `exec.stream` (long-running, streaming events)
- **Event types:** what the bridge sends unsolicited:
  - `process.output` (stdout/stderr chunks)
  - `process.exit` (process ended)
  - `fs.changed` (file/dir watcher fired)
  - `connection.heartbeat` (every N seconds, host can detect
    silent disconnect)
- **Error shape:** every response that fails returns
  `{type: "error", id, code, message}` with a defined enum of
  error codes (`unauthorized`, `not_found`, `permission_denied`,
  `protocol_version_mismatch`, `operation_failed`, `timeout`).
- **Auth handshake:** first message after WebSocket open is
  `{type: "auth", token: "..."}`. Bridge responds with
  `{type: "auth_ok", machine_name, version}` or an error.
- **Reconnect:** bridge initiates. Exponential backoff starting
  at 1s, max 60s. On reconnect, host should be able to
  re-subscribe to file watches and list active processes (bridge
  state survives socket disconnects, not bridge restarts).
- **Heartbeat / timeout:** every 30s the bridge sends
  `connection.heartbeat`. If the host doesn't see one for 90s,
  it considers the connection dead and reconnects.
- **Operation cancellation:** the host can send
  `{type: "cancel", id}` to abort an in-flight RPC. Bridge
  best-effort cancels.
- **Output document:** `PHASE_6_PROTOCOL.md` committed.

**Done when:**

- `PHASE_6_PROTOCOL.md` exists with:
  - Full operation list with request/response payloads.
  - Full event list with payloads.
  - Auth flow.
  - Reconnect + heartbeat semantics.
  - Error code enum.
  - One example exchange (worktree create) showing the full
    wire trace.

**Out of scope:**

- Implementation. T0 is design-only.
- Performance tuning (msgpack, binary framing).
- Multi-user / multi-tenancy.
- Protocol negotiation beyond version check.

---

### T1 — `garrison-outpost-bridge` repo + minimal daemon

**Why:** The remote-side process. Lives in its own GitHub repo;
cloned to remote Macs by the bootstrap.

**Depends on:** T0 (protocol spec).

**Scope:**

- **Create new repo:** `garrison-outpost-bridge` on GitHub.
- **Stack:** Node 20+, stdlib-leaning. WebSocket client library
  (`ws` is the standard). Minimal dependencies.
- **Layout:**
  - `bin/garrison-outpost-bridge` — entry point.
  - `src/connection.ts` — WebSocket lifecycle, auth, reconnect,
    heartbeat.
  - `src/operations/process.ts` — process namespace handlers.
  - `src/operations/fs.ts` — fs namespace handlers.
  - `src/operations/git.ts` — git namespace handlers.
  - `src/operations/exec.ts` — exec namespace handlers.
  - `src/router.ts` — dispatches incoming `type` to the right
    handler.
  - `package.json`, `tsconfig.json`, `README.md`.
- **Daemon behavior:**
  - Reads host address and token from
    `~/.garrison-outpost/config.json`.
  - Reads machine name from same.
  - Connects, authenticates, registers operation handlers.
  - On disconnect, exponential backoff reconnect.
  - Logs to `~/.garrison-outpost/logs/<date>.log` with daily
    rotation.
- **Process namespace:** spawn via `child_process.spawn`. Track
  active PIDs in memory. Stream stdout/stderr as `process.output`
  events with the operation ID as correlation. Emit `process.exit`
  on exit.
- **FS namespace:** stdlib `fs` and `fs/promises`. `fs.watch` for
  watchers (with active-watcher tracking).
- **Git namespace:** shells out to `git worktree` commands.
  No libgit2.
- **Exec namespace:** `exec.run` for one-shot (returns full
  output). `exec.stream` reuses process namespace internally with
  a single command.
- **launchd plist:** ship `garrison-outpost-bridge.plist` in the
  repo for macOS daemon installation. Bootstrap script (T3)
  installs it.
- **Versioning:** package.json version + a `PROTOCOL_VERSION`
  constant. Both reported in auth handshake.

**Done when:**

- The repo exists on GitHub.
- `bin/garrison-outpost-bridge` runs locally against a test host
  (mock WebSocket server).
- Can connect, auth, handle a `process.spawn` followed by
  `process.kill`.
- Can handle disconnect + reconnect cleanly.
- Logs go to the right place.

**Out of scope:**

- Auto-update.
- Cross-platform (macOS only).
- Multiple host connections per bridge.
- Operation rate limiting.

---

### T2 — `outpost:tailscale-host` host-side Fitting

**Why:** The host-side counterpart to T1's bridge. Each remote Mac
gets one of these Fittings configured for it.

**Depends on:** T0, T1.

**Scope:**

- New Fitting at `fittings/seed/outpost-tailscale-host/`.
- `apm.yml`:
  - `faculty: outposts` (new Faculty kind, declared as part of
    this Fitting's setup or in core — see open question).
  - `provides: { kind: outpost, name: <configured-machine-name> }`
  - `consumes: { kind: vault, cardinality: optional-one }` (for
    storing the bridge token).
  - `setup: ./scripts/setup.sh` (validates Tailscale address,
    token in vault, machine name).
- **Connection management:**
  - Host-side WebSocket server endpoint (probably new gateway
    route, since the gateway is the long-lived process on the
    host). Outposts Fittings *register* an outpost name with the
    gateway; bridges *connect* to the gateway.
  - The Fitting subscribes to events for its outpost name.
  - On bridge disconnect, retry with backoff.
- **Capability surface:**
  - Each outpost provides operations as the same protocol
    namespaces. The capability shape lets consumer Fittings call
    `outpost.process.spawn(...)`, etc.
  - In practice: the Fitting exposes a TypeScript API that other
    Fittings import or invoke via the wiring graph.
- **UI surface:** sidebar surface (contract v2) showing connected
  outposts with status indicators:
  - Connected / disconnected / reconnecting.
  - Last heartbeat timestamp.
  - Active operation count.
  - "Generate bootstrap" button for adding a new outpost.

**Done when:**

- An outpost Fitting can be added to a composition with a
  configured machine name + Tailscale address.
- When the corresponding bridge connects, the Fitting shows
  "connected".
- A test process.spawn call from the host routes correctly to
  the bridge and returns output.
- Bridge disconnects are detected within 90s; reconnects appear
  promptly.

**Out of scope:**

- Multi-bridge per Fitting (one Fitting = one outpost).
- Cross-outpost operation routing.
- Persistent state across host restarts (host reconnects
  fresh).

**Open questions to flag:**

1. **Where the WebSocket server lives.** The host gateway is the
   natural home (long-lived, already handling other connections),
   but it currently does HTTP. Adding a WebSocket route is small;
   confirm the gateway can host both cleanly.
2. **How outposts Fittings interact with the gateway-as-WS-server.**
   The gateway accepts the WebSocket connection; the Fitting
   subscribes to that connection's events. Mechanism for the
   subscription needs designing — probably an in-process event
   bus or registry pattern.

---

### T3 — Bootstrap flow

**Why:** Getting the bridge onto a fresh remote Mac with one
command.

**Depends on:** T1, T2.

**Scope:**

- **Token generation:** the host's outpost Fitting (or a CLI
  helper) generates a token for a new outpost: 32 bytes random,
  hex-encoded. Stores in the vault as
  `OUTPOST_TOKEN_<machine_name>`.
- **Bootstrap one-liner:** a curl-pipe-bash command the user runs
  on the remote Mac. Something like:
  ```
  curl -fsSL https://garrison.io/outpost-bootstrap.sh | \
    GARRISON_HOST=mac-mini.tailnet GARRISON_TOKEN=... \
    GARRISON_MACHINE_NAME=mac-2 bash
  ```
  Or, simpler for v1: a script the user copies via SSH from the
  host:
  ```
  scp host:garrison/scripts/bootstrap-outpost.sh ./
  GARRISON_HOST=... GARRISON_TOKEN=... ./bootstrap-outpost.sh
  ```
  Pick one for v1 (lean: SCP'd script, since "garrison.io/..."
  doesn't exist yet).
- **What the script does:**
  - Verifies Tailscale is installed and connected.
  - Clones `garrison-outpost-bridge` to `~/.garrison-outpost/`.
  - Runs `npm install` (or `pnpm install` — match the bridge
    repo's choice).
  - Writes `~/.garrison-outpost/config.json` with host address,
    token, machine name.
  - Installs the launchd plist:
    `~/Library/LaunchAgents/io.garrison.outpost.plist`.
  - Loads the plist with `launchctl bootstrap gui/$(id -u)`.
  - Verifies the daemon is running.
  - Verifies the bridge connects to the host (waits up to 30s,
    polls `~/.garrison-outpost/logs/` for the auth_ok line).
- **UI integration in the host outpost Fitting:**
  - "Add Outpost" form: user enters machine name + Tailscale
    address.
  - On submit, the host generates a token, stores it, and shows
    the user the exact command to run on the remote Mac.
  - Once the bridge connects, the new outpost appears in the
    sidebar list.

**Done when:**

- I can run the bootstrap on a fresh Mac that has Tailscale.
- Within a minute, the bridge appears as connected in the
  Outposts Faculty UI.
- The bridge survives a remote Mac reboot (launchd restarts
  it).
- `bootstrap-outpost.sh` exits non-zero with a clear message if
  any step fails (no Tailscale, no Node, bridge auth fails,
  etc.).

**Out of scope:**

- Public hosted bootstrap URL.
- Auto-updating bridges across machines.
- Bridge uninstall script (manual: stop launchd job, delete
  dir).

---

### T4 — Armory integration: terminal with outpost selector

**Why:** First Armory Fitting to gain outpost-awareness. The
terminal becomes "spawn a shell on any connected outpost or
locally."

**Depends on:** T2.

**Scope:**

- Update `terminal:armory-default` Fitting:
  - Adds `consumes: { kind: outpost, cardinality: any }`.
  - UI: dropdown selector in the terminal toolbar showing local +
    all connected outposts.
  - Default: local.
  - On "New Terminal", route the PTY spawn to the selected
    outpost via its `process.spawn` operation.
  - Terminal I/O flows through `process.output` events from the
    bridge and `process.send_input` requests to it.
- The xterm.js component on the host doesn't need to know the PTY
  is remote — the abstraction is "I'm reading from / writing to
  a process," local or remote.
- Busy/idle detection logic (Phase 5's heuristic) works on the
  output stream regardless of source.
- Launch presets (Open Orchestrator, Open Claude Code) gain the
  same selector. Open Orchestrator stays local-only (the
  assembled prompt is a local file).

**Done when:**

- I select an outpost in the dropdown, click New Terminal, get
  a shell on that remote Mac.
- Multiple terminals across multiple outposts all work
  concurrently in the same Armory area.
- Closing a terminal kills the remote PTY (verify via
  `ps aux` on the remote machine).
- Disconnect of an outpost mid-session surfaces clearly in the
  terminal UI (banner: "outpost disconnected, reconnecting...").

**Out of scope:**

- Migrating an open terminal from one outpost to another.
- Local-to-remote file drag-drop.
- Performance optimization for high-throughput output streams.

---

### T5 — Armory integration: worktree-management

**Why:** Second Armory Fitting with outpost-awareness. Worktrees
live on the machine they're on; selector picks which.

**Depends on:** T2, T4 (so terminal-on-outpost is already
verified).

**Scope:**

- Update `worktree-management:sequoias`:
  - Adds `consumes: { kind: outpost, cardinality: any }`.
  - "Worktree on Outpost" — each worktree's metadata includes
    which machine it lives on.
  - UI: per-worktree machine label. "Create Worktree" form has
    an outpost selector.
  - Worktree operations (create, delete, list, status) route to
    the right outpost via `git.*` operations on the bridge.
- Worktree state storage:
  - Per-outpost worktree list comes from the bridge's
    `git.list_worktrees` operation on that machine.
  - The host caches the aggregate view; refreshes on bridge
    events (filesystem watches on the git dir).
- "Open Terminal" on a worktree spawns the terminal on the
  worktree's outpost — uses T4's terminal-on-outpost
  capability.

**Done when:**

- I create a worktree on a remote Mac via Garrison's UI from
  whichever Mac I'm sitting at. The worktree appears on the
  correct machine's disk.
- Click "Open Terminal" on that worktree → terminal opens on
  the correct machine in the correct directory.
- I see worktrees across all my connected outposts in one list.
- Deleting a worktree removes it from the right machine.

**Out of scope:**

- Migrating a worktree from one outpost to another.
- Cross-outpost branch operations.

---

### T6 — Armory integration: session-view

**Why:** Third Armory Fitting. Status aggregated across all
outposts.

**Depends on:** T2, T4, T5.

**Scope:**

- Update `session-view:sequoias`:
  - Consumes worktree list from T5 (now multi-outpost).
  - Consumes terminal sessions from T4 (now multi-outpost).
  - Status indicators per worktree show which outpost it's on
    and current state (running, idle, needs attention).
  - Aggregate state visible across all outposts in a single
    view.
- Status detection signals come from bridge events:
  - `process.output` activity → busy.
  - `process.exit` → status update.
  - `fs.changed` events on key files → "needs attention"
    heuristic.

**Done when:**

- session-view shows all worktrees across all outposts.
- Status indicators update live as terminals on remote outposts
  go busy/idle.
- Actions (open PR, kill session, refocus) route to the right
  outpost.

**Out of scope:**

- Per-outpost filtering UI (defer if the multi-outpost view
  gets cluttered, but probably fine for 3 machines).

---

### T7 — `outpost-actions` agent-skill Fitting

**Why:** Operative-side bridge usage. The Operative gains
agent-callable tools that target specific outposts.

**Depends on:** T2.

**Scope:**

- New seed Fitting at `fittings/seed/outpost-actions/`.
- `apm.yml`:
  - `faculty: skills`.
  - Shape: cli-skill.
  - `provides: { kind: agent-skill, name: outpost-actions }`.
  - `consumes: { kind: outpost, cardinality: any }`.
- **CLI tools the skill exposes to the Operative:**
  - `list_outposts` — names and statuses of connected
    machines.
  - `run_on(machine, command)` — exec.run via the bridge.
  - `spawn_on(machine, command)` — exec.stream, returns an
    operation ID the Operative can `wait_for_completion` or
    `kill`.
  - `read_file_on(machine, path)`.
  - `write_file_on(machine, path, content)`.
  - `list_files_on(machine, path)`.
- **`for_consumers` block:** "When the user mentions a machine
  by name (e.g. 'on my mac-mini', 'on machine X'), or when a
  task is naturally local to a specific machine, route through
  outpost-actions. For tasks that don't specify a machine, act
  locally with your normal tools. Don't introduce remote calls
  speculatively."

**Done when:**

- I ask the Operative "run `uname -a` on mac-2" and it returns
  the right output.
- "Read `~/Projects/x/README.md` on mac-mini" works.
- "Spawn a long-running command on mac-2 and tell me when it's
  done" works.

**Out of scope:**

- Cross-outpost data transfer (read from A, write to B in one
  step). v1 = chain calls via the Operative.
- Operative *choosing* which outpost based on workload.
  Operative picks based on user instruction, not optimization.

---

### T8 — `vault-sync` Fitting

**Why:** First non-Armory consumer of the bridge. The Obsidian
vault stays in sync across machines.

**Depends on:** T2.

**Scope:**

- New seed Fitting at `fittings/seed/vault-sync/`.
- **Faculty:** new `sync` Faculty kind. Cardinality `many` (one
  Fitting per sync relationship).
  - Open question: do we add a new Faculty for this, or shoehorn
    into `automations`? Lean: new `sync` Faculty because it has
    distinct intent (mirroring, not one-shot automation).
- `apm.yml`:
  - `consumes: { kind: outpost, cardinality: many }`
  - Config: `source_dir` (path on host), `outposts` (list of
    machine names to mirror to), `interval_seconds` (default
    30).
- **Sync behavior:**
  - On schedule (via scheduler Fitting) or fs.watch event:
    - List files in `source_dir` on host (or compute a manifest
      from the local fs).
    - For each target outpost, list files on the remote at the
      same path.
    - Diff: identify files to upload (new or changed on host).
    - Use `fs.write` to push each to the outpost.
  - **Unidirectional only for v1: host → outposts.** Edits made
    on outposts are not pulled back. The host's vault is the
    authority.
  - **No conflict resolution** because no merge: last host write
    wins on the remote.
- **UI surface:** small status pane showing last sync time per
  outpost, file count, byte count. Optional, contract v2
  faculty-tab placement.

**Done when:**

- Configure vault-sync to mirror `~/Projects/ekus/obsidian-vault/`
  from host to mac-2 every 30s.
- Edit a file on host → within 30s, the change is reflected on
  mac-2.
- Delete a file on host → file disappears on mac-2 within 30s.
- (Bidirectional explicitly NOT verified — see deferred.)

**Out of scope:**

- Bidirectional sync.
- Conflict detection/resolution.
- Non-filesystem sync (databases, etc.).
- Sync of large binary files (no special handling; if it's
  slow, defer to a chunked-transfer feature later).

---

### T9 — Phase 6 verification

**Why:** Walk the Phase 6 done-when checklist.

**Depends on:** T1-T8.

**Scope:**

Walk the six roadmap done-when items:

1. Bootstrap on a second Mac → outpost shows connected in
   Outposts Faculty.
2. Create a worktree on Mac 2 from Garrison running on Mac 1.
3. Open terminal in Outpost-managed worktree from web UI →
   commands run on the remote.
4. Operative "run `ls ~/Projects` on mac-mini-2" → returns
   correct output via outpost-actions skill.
5. Vault on Mac 2 stays in sync with Mac 1's vault within a few
   seconds of changes.
6. Bridge reconnects cleanly after Mac 2 unplugs + replugs.

`PHASE6_VERIFICATION.md` mirrors prior phases.

**Done when:**

- All six items pass.
- `PHASE6_VERIFICATION.md` committed.

---

## What gets carried into Phase 7 / future phases

- **Bidirectional vault sync** — deferred. Land when there's a
  clear pattern (likely when more than one machine becomes
  authoritative for distinct subsets of the vault).
- **Linux/Windows bridges** — when platform thesis demands it.
- **Cross-outpost direct operations** (A → B without round-
  tripping the host).
- **Bridge auto-update.**
- **Per-operation rate limiting / quota.**
- **Public hosted bootstrap URL** (garrison.io/...).
- **Outpost as a target for Operative work that gets routed by
  load** (not just user instruction).

---

## What still needs an answer before T1 can ship

- **T0's protocol design.** All other tickets reference T0's
  decisions. Don't start T1 until T0 has produced
  `PHASE_6_PROTOCOL.md`.

That's it. Once T0 lands, T1–T9 proceed cleanly.
