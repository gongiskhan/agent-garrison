# Outpost Bridge Protocol v1

**Purpose:** This document specifies the wire protocol between a
`garrison-outpost-bridge` daemon running on a remote Mac and the
Garrison host's `outpost:tailscale-host` Fitting. Every Phase 6
ticket (T1 through T9) is implementable against this spec without
asking clarifying questions about the wire.

**Context:** The host machine (automation machine, Mac Mini M4) runs
Garrison and the Operative. Each remote Mac runs a bridge daemon that
opens a persistent WebSocket connection to the host. The host sends
RPC requests; the bridge executes them and streams events back.

**Deviations from brief `PHASE_6_T0_BRIEF.md`:** three additions over
the brief's literal operation list, driven by inspection of existing
consumer code. Each deviation is called out inline.

---

## 1. Transport

WebSocket over Tailscale.

JSON for v1: debuggable, no protobuf compilation step, reconnect
semantics are native to WebSocket, and the message volumes Phase 6
generates will not approach the threshold where framing overhead
matters. Switch to msgpack or binary framing only when profiling
demands it.

The host exposes a WebSocket endpoint (exact path TBD by T2; lean:
`ws://<host-tailscale-addr>:<port>/api/outposts/bridge`). All
subsequent traffic flows through this connection; SSH is used only
for the one-time bootstrap (T3).

Tailscale handles transport-level encryption. No additional
application-layer encryption in v1.

---

## 2. Message envelope

Every message is a JSON object with a fixed envelope:

```json
{
  "version": 1,
  "type": "namespace.operation",
  "id": "req-a3f9b1",
  "payload": { }
}
```

**Fields:**

- `version` — always `1` for the v1 protocol. Both sides check at
  auth handshake (§3); mismatches close the connection immediately.
- `type` — dot-separated `namespace.operation` string. Examples:
  `process.spawn`, `fs.read`, `connection.heartbeat`.
- `id` — required for RPC requests (host → bridge, host-generated,
  must be unique within the connection — lean: UUID v4 or short
  random hex). Echoed back on the corresponding response. **Absent
  on events and handshake messages.** Behaviour is undefined if
  the host reuses an `id` within a connection.
- `payload` — operation-specific object. Always present; may be
  empty `{}` for parameterless operations.

**Error framing:** when an operation fails, the bridge returns:

```json
{
  "version": 1,
  "type": "error",
  "id": "req-a3f9b1",
  "payload": {
    "code": "not_found",
    "message": "Path does not exist: /Users/ggomes/missing"
  }
}
```

Errors arrive in the normal message stream, identified by
`type: "error"` and the echoed `id`. Error codes are defined in §9.

---

## 3. Auth handshake

Auth is the first exchange after the WebSocket connection opens.
It uses the envelope format but carries no `id` (it is a handshake
flow, not an RPC).

**Bridge → Host:**
```json
{
  "version": 1,
  "type": "auth",
  "payload": {
    "token": "a3f9b1c2d4e5f607a8b9...64hexchars...",
    "machine_name": "development"
  }
}
```

**Host → Bridge (success):**
```json
{
  "version": 1,
  "type": "auth_ok",
  "payload": {
    "protocol_version": 1,
    "bridge_version": "0.1.0"
  }
}
```

**Host → Bridge (failure):**
```json
{
  "version": 1,
  "type": "error",
  "payload": {
    "code": "unauthorized",
    "message": "Invalid token"
  }
}
```

The host closes the socket immediately after an error response.
The bridge logs auth failures distinctly (separate log prefix from
transient network errors) and applies backoff before reconnecting,
but retries indefinitely. A rotated token requires a bridge restart
with the updated `config.json` — the bridge does not self-rotate.

**Protocol version mismatch:** if `auth_ok.protocol_version` differs
from the bridge's compiled `PROTOCOL_VERSION` constant, the bridge
closes the connection and logs `protocol_version_mismatch`. It does
not reconnect until restarted with a compatible version.

**Token format:** 32 random bytes, hex-encoded (64 hex chars).
The host generates this when creating the outpost Fitting. Stored on
the bridge side in `~/.garrison-outpost/config.json`.

---

## 4. Operation namespaces

### 4.1 `process.*`

Manages OS processes on the remote machine. A PTY shell (interactive
terminal) and a plain command (for `exec.*`) are both spawned via
`process.spawn`; the `pty` flag distinguishes them.

**Deviations from brief:**
- Operations use `handle` (opaque UUID string minted by the bridge)
  instead of `pid`. OS PIDs get reaped and reused; a stable opaque
  handle is the correct correlation key.
- `process.spawn` gains `pty`, `cols`, `rows` for PTY mode.
- `process.resize { handle, cols, rows }` is added. Without it T4
  (terminal-on-outpost) cannot ship a usable terminal; the existing
  trenches WS server (`scripts/trenches-ws.mjs`) already requires
  resize semantics.
- `process.output.data` is base64-encoded to keep all frames as JSON
  (PTY output is raw bytes including ANSI escape sequences).
- Bridge does **not** auto-reap processes. Today's trenches 5-minute
  reaper is host policy, not bridge policy. Brief §3.6 intention
  ("spawned processes survive") is honoured.

---

**`process.spawn`**

Request:
```json
{
  "version": 1, "type": "process.spawn", "id": "req-002",
  "payload": {
    "command": "/bin/zsh",
    "args": [],
    "cwd": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui",
    "env": { "TERM": "xterm-256color" },
    "pty": true,
    "cols": 220,
    "rows": 50
  }
}
```

`pty` defaults to `false`. When `true`, the bridge allocates a PTY
and attaches `command` to it. `cols` and `rows` default to `80` / `24`
when `pty: true` and omitted. `cwd`, `env`, `args` are all optional.

Response:
```json
{
  "version": 1, "type": "process.spawn", "id": "req-002",
  "payload": { "handle": "h-f4a9b1c2" }
}
```

The bridge streams `process.output` events from this point. Processes
are **not** auto-reaped — they outlive socket disconnects (the OS
keeps them running). Terminate explicitly with `process.kill`.

Errors: `operation_failed` (failed to fork or allocate PTY).

---

**`process.kill`**

Request:
```json
{
  "version": 1, "type": "process.kill", "id": "req-010",
  "payload": { "handle": "h-f4a9b1c2", "signal": "SIGTERM" }
}
```

`signal` defaults to `SIGTERM`. Bridge sends the signal and awaits
`process.exit`; the host does not need to poll.

Response:
```json
{
  "version": 1, "type": "process.kill", "id": "req-010",
  "payload": { "ok": true }
}
```

Errors: `not_found` (handle unknown or process already exited).

---

**`process.send_input`**

Request:
```json
{
  "version": 1, "type": "process.send_input", "id": "req-012",
  "payload": {
    "handle": "h-f4a9b1c2",
    "data": "bHMgLWxhCg=="
  }
}
```

`data` is base64-encoded bytes written to the process's stdin (or
PTY master fd for PTY processes). For PTY shells, this is the raw
input stream including control characters.

Response:
```json
{
  "version": 1, "type": "process.send_input", "id": "req-012",
  "payload": { "ok": true }
}
```

Errors: `not_found`, `operation_failed` (write failed, e.g., process
closed stdin).

---

**`process.resize`** *(deviation from brief — required for PTY terminals)*

Request:
```json
{
  "version": 1, "type": "process.resize", "id": "req-013",
  "payload": { "handle": "h-f4a9b1c2", "cols": 180, "rows": 45 }
}
```

Only valid for PTY-spawned processes. Bridge calls
`ioctl(fd, TIOCSWINSZ, ...)` on the PTY master fd.

Response:
```json
{
  "version": 1, "type": "process.resize", "id": "req-013",
  "payload": { "ok": true }
}
```

Errors: `not_found`, `operation_failed` (not a PTY process).

---

**`process.list`**

Request:
```json
{
  "version": 1, "type": "process.list", "id": "req-020",
  "payload": {}
}
```

Response:
```json
{
  "version": 1, "type": "process.list", "id": "req-020",
  "payload": {
    "processes": [
      {
        "handle": "h-f4a9b1c2",
        "command": "/bin/zsh",
        "started_at": "2026-05-11T10:22:30Z"
      }
    ]
  }
}
```

Lists processes tracked by this bridge session. Processes started in
a prior bridge session that survived (as OS-level orphans after a
bridge restart) do **not** appear — their handles are not in the
bridge's in-memory state. On socket-only reconnect (bridge process
stayed alive), all handles survive and appear normally.

---

**`process.status`**

Request:
```json
{
  "version": 1, "type": "process.status", "id": "req-021",
  "payload": { "handle": "h-f4a9b1c2" }
}
```

Response:
```json
{
  "version": 1, "type": "process.status", "id": "req-021",
  "payload": { "handle": "h-f4a9b1c2", "running": true, "exit_code": null }
}
```

`exit_code` is `null` while the process is running. After exit, the
bridge retains the exit code until the bridge restarts.

Errors: `not_found`.

---

### 4.2 `fs.*`

Filesystem operations on the remote machine. All paths are resolved
on the remote side; tilde (`~`) is expanded to the bridge user's home
directory.

---

**`fs.read`**

Request:
```json
{
  "version": 1, "type": "fs.read", "id": "req-030",
  "payload": {
    "path": "/Users/ggomes/.garrison/sessions/state.json",
    "encoding": "utf8"
  }
}
```

`encoding` defaults to `"utf8"`. Use `"base64"` for binary files.

Response:
```json
{
  "version": 1, "type": "fs.read", "id": "req-030",
  "payload": { "content": "{\"sessions\": ...}" }
}
```

Errors: `not_found`, `permission_denied`, `operation_failed`.

---

**`fs.write`**

Request:
```json
{
  "version": 1, "type": "fs.write", "id": "req-031",
  "payload": {
    "path": "/Users/ggomes/Projects/my-app/notes.md",
    "content": "# Notes",
    "encoding": "utf8"
  }
}
```

`encoding` defaults to `"utf8"`. Use `"base64"` for binary content.

Response:
```json
{
  "version": 1, "type": "fs.write", "id": "req-031",
  "payload": { "ok": true }
}
```

Errors: `permission_denied`, `not_found` (parent dir missing),
`operation_failed`.

---

**`fs.list`**

Request:
```json
{
  "version": 1, "type": "fs.list", "id": "req-032",
  "payload": { "path": "/Users/ggomes/Projects" }
}
```

Response:
```json
{
  "version": 1, "type": "fs.list", "id": "req-032",
  "payload": {
    "entries": [
      { "name": "my-app", "type": "directory", "size": 0 },
      { "name": "README.md", "type": "file", "size": 4096 }
    ]
  }
}
```

`type` is `"file"`, `"directory"`, or `"symlink"`. Non-recursive —
one directory level only.

Errors: `not_found`, `permission_denied`.

---

**`fs.exists`**

Request:
```json
{
  "version": 1, "type": "fs.exists", "id": "req-033",
  "payload": { "path": "/Users/ggomes/.garrison/sessions/state.json" }
}
```

Response:
```json
{
  "version": 1, "type": "fs.exists", "id": "req-033",
  "payload": { "exists": true, "type": "file" }
}
```

`type` is omitted when `exists: false`.

---

**`fs.mkdir`**

Request:
```json
{
  "version": 1, "type": "fs.mkdir", "id": "req-034",
  "payload": { "path": "/Users/ggomes/.garrison-outpost/logs", "recursive": true }
}
```

`recursive` defaults to `false`.

Response:
```json
{
  "version": 1, "type": "fs.mkdir", "id": "req-034",
  "payload": { "ok": true }
}
```

Errors: `permission_denied`, `operation_failed`.

---

**`fs.delete`**

Request:
```json
{
  "version": 1, "type": "fs.delete", "id": "req-035",
  "payload": { "path": "/tmp/scratch.txt", "recursive": false }
}
```

`recursive` defaults to `false`. Set `true` to remove a directory
tree.

Response:
```json
{
  "version": 1, "type": "fs.delete", "id": "req-035",
  "payload": { "ok": true }
}
```

Errors: `not_found`, `permission_denied`.

---

**`fs.watch`**

Request:
```json
{
  "version": 1, "type": "fs.watch", "id": "req-036",
  "payload": {
    "path": "/Users/ggomes/.garrison/sessions/state.json",
    "recursive": false
  }
}
```

Bridge installs a filesystem watcher. Subsequent changes fire
`fs.changed` events (§5.3) until `fs.unwatch`. All watches are
dropped on bridge reconnect; host must re-subscribe after
`connection.reconnected`.

Response:
```json
{
  "version": 1, "type": "fs.watch", "id": "req-036",
  "payload": { "watch_id": "w-9a1b2c3d" }
}
```

The `watch_id` correlates future `fs.changed` events for this watch.

Errors: `not_found`, `operation_failed`.

---

**`fs.unwatch`**

Request:
```json
{
  "version": 1, "type": "fs.unwatch", "id": "req-037",
  "payload": { "watch_id": "w-9a1b2c3d" }
}
```

Response:
```json
{
  "version": 1, "type": "fs.unwatch", "id": "req-037",
  "payload": { "ok": true }
}
```

Errors: `not_found` (watch_id unknown).

---

### 4.3 `git.*`

Git operations shell out to the `git` binary on the remote machine.
No libgit2.

**Deviations from brief:**
- `git.create_worktree` adds `base_branch?` (defaults to `main`;
  matches `createWorktree`'s `baseBranch?` arg in `src/lib/worktrees.ts`).
- `git.delete_worktree` adds required `repo_path` (needed to run
  `git worktree remove` from inside the repository).
- `git.list_worktrees` entries carry optional `ports` and `env_files`
  populated from each worktree's `.garrison-meta.json` — avoids a
  round-trip `fs.read` per worktree on the host side.

---

**`git.list_worktrees`**

Request:
```json
{
  "version": 1, "type": "git.list_worktrees", "id": "req-040",
  "payload": { "repo_path": "/Users/ggomes/Projects/my-app" }
}
```

Response:
```json
{
  "version": 1, "type": "git.list_worktrees", "id": "req-040",
  "payload": {
    "worktrees": [
      {
        "worktree_path": "/Users/ggomes/Projects/my-app",
        "branch": "main",
        "commit": "a1b2c3d4",
        "is_main": true,
        "ports": {},
        "env_files": []
      },
      {
        "worktree_path": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui",
        "branch": "feature/phase6-ui",
        "commit": "e5f6a7b8",
        "is_main": false,
        "ports": { "dev": 51234 },
        "env_files": [".env.local"]
      }
    ]
  }
}
```

Bridge populates `ports` and `env_files` from `.garrison-meta.json`
in each worktree if present; returns empty `{}` / `[]` if the file
does not exist. `commit` is the short hash (8 chars), matching the
`Worktree` shape in `src/lib/worktrees.ts`.

Errors: `not_found` (repo not found), `operation_failed` (git error).

---

**`git.create_worktree`**

Request:
```json
{
  "version": 1, "type": "git.create_worktree", "id": "req-041",
  "payload": {
    "repo_path": "/Users/ggomes/Projects/my-app",
    "branch": "feature/phase6-ui",
    "base_branch": "main"
  }
}
```

`base_branch` defaults to `main`. The bridge derives the target path
from repo name + branch slug using the canonical layout
(`~/.worktrees/<repoName>/<branchSlug>`) — callers do not specify
it; the bridge returns the created path. The bridge runs:
`git worktree add -b <branch> <target_path> <base_branch>`.

Response:
```json
{
  "version": 1, "type": "git.create_worktree", "id": "req-041",
  "payload": {
    "path": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui"
  }
}
```

Errors: `operation_failed` (branch already exists, git error, etc.).

---

**`git.delete_worktree`**

Request:
```json
{
  "version": 1, "type": "git.delete_worktree", "id": "req-042",
  "payload": {
    "worktree_path": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui",
    "repo_path": "/Users/ggomes/Projects/my-app"
  }
}
```

`repo_path` is required: `git worktree remove` must run from inside
the repository. Bridge runs:
`git worktree remove --force <worktree_path>` from `repo_path`.

Response:
```json
{
  "version": 1, "type": "git.delete_worktree", "id": "req-042",
  "payload": { "ok": true }
}
```

Errors: `not_found`, `operation_failed`.

---

**`git.status`**

Request:
```json
{
  "version": 1, "type": "git.status", "id": "req-043",
  "payload": { "worktree_path": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui" }
}
```

Response:
```json
{
  "version": 1, "type": "git.status", "id": "req-043",
  "payload": {
    "branch": "feature/phase6-ui",
    "dirty": true,
    "ahead": 2,
    "behind": 0
  }
}
```

Errors: `not_found`, `operation_failed`.

---

### 4.4 `exec.*`

One-shot and streaming command execution. Unlike `process.spawn`
(PTY-capable, long-lived), `exec.*` is for fire-and-forget or short
streaming runs. The command string is passed to `/bin/sh -c`.

---

**`exec.run`**

Request:
```json
{
  "version": 1, "type": "exec.run", "id": "req-050",
  "payload": {
    "command": "uname -a",
    "cwd": "/Users/ggomes",
    "env": {},
    "timeout_ms": 10000
  }
}
```

`cwd`, `env`, `timeout_ms` are all optional. Response arrives after
the command exits (no streaming).

Response:
```json
{
  "version": 1, "type": "exec.run", "id": "req-050",
  "payload": {
    "stdout": "Darwin MacBook-Pro-M1.local 25.3.0...",
    "stderr": "",
    "exit_code": 0
  }
}
```

Errors: `timeout` (if `timeout_ms` elapsed), `operation_failed`.

---

**`exec.stream`**

Starts a long-running command; stdout/stderr are streamed via
`process.output` events using the operation `id` as the handle
(no separate handle is minted). When the command exits, the bridge
sends a final `process.exit` event.

Request:
```json
{
  "version": 1, "type": "exec.stream", "id": "req-051",
  "payload": {
    "command": "npm run build",
    "cwd": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui",
    "env": {}
  }
}
```

Response (immediate — confirms the stream started):
```json
{
  "version": 1, "type": "exec.stream", "id": "req-051",
  "payload": { "ok": true }
}
```

Bridge then emits `process.output` events with `handle: "req-051"`
(the operation `id`). When done:
```json
{
  "version": 1, "type": "process.exit",
  "payload": { "handle": "req-051", "exit_code": 0, "signal": null }
}
```

To cancel: `{ "type": "cancel", "id": "req-051" }` (§8) sends
SIGTERM and emits `process.exit`.

Errors: `operation_failed` (command not found, etc.).

---

## 5. Event types (bridge → host, unsolicited)

Events carry no `id`. Consumers correlate via `handle` or `watch_id`
in the payload.

### 5.1 `process.output`

```json
{
  "version": 1, "type": "process.output",
  "payload": {
    "handle": "h-f4a9b1c2",
    "stream": "stdout",
    "data": "bHMgLWxhCg=="
  }
}
```

`handle` is either a process handle (from `process.spawn`) or an
operation `id` (from `exec.stream`).

`data` is base64-encoded bytes.

`stream` is `"stdout"` or `"stderr"` for non-PTY processes.
For PTY-spawned processes, `stream` is always `"stdout"` — PTYs
merge stdout and stderr on the master fd; the discriminator is
meaningless in PTY mode and consumers must not rely on
`stream: "stderr"` for PTY processes.

### 5.2 `process.exit`

```json
{
  "version": 1, "type": "process.exit",
  "payload": {
    "handle": "h-f4a9b1c2",
    "exit_code": null,
    "signal": "SIGTERM"
  }
}
```

`exit_code` is `null` when the process was terminated by a signal.
`signal` is the signal name (e.g., `"SIGTERM"`) when applicable,
`null` otherwise.

### 5.3 `fs.changed`

```json
{
  "version": 1, "type": "fs.changed",
  "payload": {
    "watch_id": "w-9a1b2c3d",
    "path": "/Users/ggomes/.garrison/sessions/state.json",
    "kind": "modified"
  }
}
```

`kind` is `"added"`, `"modified"`, or `"removed"`.

**Atomic-rename caveat:** Garrison's `garrison-sessions.ts` writes
`state.json` atomically via `path.tmp` → rename. On macOS (FSEvents)
this surfaces as `removed` (the original) then `added` (the renamed
file) rather than `modified`. Consumers must re-read the file on any
of `{added, modified}` for a watched path, not only on `"modified"`.

**Initial state:** `fs.watch` is event-driven — it delivers changes
that occur *after* subscription. Consumers must `fs.read` *before*
subscribing to capture current state. Recommended sequence:
1. `fs.read` — get current state.
2. `fs.watch` — subscribe to changes; record the `watch_id`.
3. On each `fs.changed` event for that `watch_id` — `fs.read` again.

### 5.4 `connection.heartbeat`

```json
{
  "version": 1, "type": "connection.heartbeat",
  "payload": { "timestamp": "2026-05-11T10:25:00Z" }
}
```

Bridge sends every 30 seconds. Host marks the connection dead if no
heartbeat arrives for 90 seconds and closes the socket.

### 5.5 `connection.reconnected`

```json
{
  "version": 1, "type": "connection.reconnected",
  "payload": {
    "machine_name": "development",
    "bridge_version": "0.1.0"
  }
}
```

Bridge sends this immediately after `auth_ok` when it is reconnecting
(not the initial connection). Signal to the host that all `fs.watch`
subscriptions and in-flight RPCs have been lost; the host should
re-subscribe and retry pending operations.

---

## 6. Reconnect strategy

The **bridge** initiates reconnects (WebSocket client). The host
(server) does not attempt to call back.

**Backoff:** exponential, starting at 1s, doubling each attempt up
to 60s maximum. Each interval is jittered ±20% to avoid thundering
herd when multiple bridges restart together.

**Auth on reconnect:** same token, same machine name. The full auth
handshake repeats from scratch on each reconnect.

**State recovery on reconnect:**

| State | Survives? | Recovery action |
|---|---|---|
| In-flight RPC requests | Lost | Host retries after `connection.reconnected` |
| `fs.watch` subscriptions | Lost | Host re-subscribes after `connection.reconnected` |
| Spawned OS processes | Survive (the OS keeps them) | Host calls `process.list` to see what's running |
| `exec.stream` streams | Lost | Host retries if needed |

Processes spawned in a prior bridge *process* session (bridge
restarted, not just socket-reconnected) do not appear in
`process.list` — their handles are not in the bridge's new in-memory
state. They survive as OS-level orphans until the user explicitly
kills them.

**Max reconnect attempts:** none. Bridge retries forever (with capped
backoff). User shuts the bridge down explicitly via launchctl or
SIGTERM.

---

## 7. Heartbeat / liveness

- Bridge sends `connection.heartbeat` every **30 seconds**.
- Host considers the connection dead if no heartbeat arrives for
  **90 seconds**; it closes the socket.
- Bridge reconnects per §6.
- Why bridge sends rather than host pings: bridge owns its uptime;
  host watches passively. Simpler than bidirectional ping/pong.

---

## 8. Operation cancellation

Host sends a cancel message to abort an in-flight RPC:

```json
{
  "version": 1,
  "type": "cancel",
  "id": "req-051"
}
```

`id` matches the request to cancel. The cancel message itself
produces no response.

**Semantics:** best-effort.
- If the operation has already completed when cancel arrives, the
  response goes back as if cancel never happened.
- For `exec.stream` and PTY processes: cancel sends `SIGTERM` to
  the spawned process; bridge emits `process.exit` with
  `signal: "SIGTERM"` when it exits.
- For other blocking operations (`fs.read`, `exec.run`, etc.):
  bridge abandons the operation and sends an error response with
  `code: "cancelled"`.

---

## 9. Error code enum

| Code | When bridge returns it | What host should do |
|---|---|---|
| `unauthorized` | Invalid or missing token at auth handshake | Log distinctly; apply backoff; do not retry in a tight loop |
| `not_found` | File, dir, process, or worktree does not exist | Surface to user or caller; do not auto-retry |
| `permission_denied` | OS-level permission failure | Surface to user; a retry won't help without permission changes |
| `protocol_version_mismatch` | Bridge version incompatible with host | Bridge stops reconnecting; user must update bridge |
| `operation_failed` | Underlying command or syscall failed | Check `message` for details; surface to user |
| `timeout` | Request had `timeout_ms` set and it elapsed | Retry with a higher timeout or surface to user |
| `cancelled` | Host sent `cancel` for this operation | Expected; do not treat as an error in the UI |
| `invalid_payload` | Request payload missing required fields or wrong type | Fix the caller; this is a programming error |

---

## 10. Worked example

**Scenario:** From the host's Garrison UI, create a worktree on the
development machine and open an interactive terminal in it.

**Actors:**
- Host: Mac Mini M4 running Garrison (WebSocket server).
- Bridge: MacBook Pro M1 Max running `garrison-outpost-bridge`
  (WebSocket client).

Messages are prefixed with sender: `[B→H]` (bridge to host) or
`[H→B]` (host to bridge). Timing assumes ~5ms Tailscale round-trip.

```
T=0ms
[B→H] Bridge opens WebSocket, immediately sends auth:
{ "version": 1, "type": "auth",
  "payload": { "token": "a3f9b1c2...64hexchars...", "machine_name": "development" } }

T=5ms
[H→B] Auth accepted:
{ "version": 1, "type": "auth_ok",
  "payload": { "protocol_version": 1, "bridge_version": "0.1.0" } }

--- Periodic heartbeat stream begins; bridge sends every 30s ---

--- User clicks "Create Worktree" in Garrison UI, outpost=development ---

T=200ms
[H→B] Create worktree:
{ "version": 1, "type": "git.create_worktree", "id": "req-001",
  "payload": {
    "repo_path": "/Users/ggomes/Projects/my-app",
    "branch": "feature/phase6-ui",
    "base_branch": "main" } }

T=800ms  (git worktree add takes ~600ms)
[B→H] Worktree created:
{ "version": 1, "type": "git.create_worktree", "id": "req-001",
  "payload": { "path": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui" } }

--- User clicks "Open Terminal" on the new worktree ---

T=900ms
[H→B] Spawn PTY shell:
{ "version": 1, "type": "process.spawn", "id": "req-002",
  "payload": {
    "command": "/bin/zsh", "args": [],
    "cwd": "/Users/ggomes/.worktrees/my-app/feature-phase6-ui",
    "env": { "TERM": "xterm-256color" },
    "pty": true, "cols": 220, "rows": 50 } }

T=905ms
[B→H] PTY spawned:
{ "version": 1, "type": "process.spawn", "id": "req-002",
  "payload": { "handle": "h-f4a9b1c2" } }

T=920ms  (shell startup — ANSI sequences + prompt)
[B→H] process.output:
{ "version": 1, "type": "process.output",
  "payload": { "handle": "h-f4a9b1c2", "stream": "stdout",
               "data": "G1sxbXByb2plY3Q..." } }    ← base64 of prompt

--- User types "ls -la" in the terminal tab ---

T=3000ms
[H→B] Send user input:
{ "version": 1, "type": "process.send_input", "id": "req-003",
  "payload": { "handle": "h-f4a9b1c2", "data": "bHMgLWxhCg==" } }
                                                    ← base64 of "ls -la\n"

T=3005ms
[B→H] Input accepted:
{ "version": 1, "type": "process.send_input", "id": "req-003",
  "payload": { "ok": true } }

T=3020ms  (ls output)
[B→H] process.output:
{ "version": 1, "type": "process.output",
  "payload": { "handle": "h-f4a9b1c2", "stream": "stdout",
               "data": "dG90YWwgNDgKZHJ3eH..." } }  ← base64 of ls output

--- User closes the terminal tab ---

T=5000ms
[H→B] Kill the shell:
{ "version": 1, "type": "process.kill", "id": "req-004",
  "payload": { "handle": "h-f4a9b1c2", "signal": "SIGTERM" } }

T=5005ms
[B→H] Kill accepted:
{ "version": 1, "type": "process.kill", "id": "req-004",
  "payload": { "ok": true } }

T=5020ms  (zsh exits after SIGTERM)
[B→H] process.exit:
{ "version": 1, "type": "process.exit",
  "payload": { "handle": "h-f4a9b1c2", "exit_code": null, "signal": "SIGTERM" } }
```

Every message has a sender, a recipient, an effect, and the next step
is obvious. All field names and shapes are defined in §4–5.

**Consumer pattern — session status via `fs.watch`:**
Garrison's `session-view-sequoias` Fitting tracks Claude Code session
status from `~/.garrison/sessions/state.json` (written by Claude Code
hooks via `src/lib/garrison-sessions.ts`). Status values are:
`starting`, `working`, `waiting`, `idle`, `errored`, `dead`. For a
remote outpost, the Fitting uses the existing `fs.*` operations —
no new event type is required:
1. `fs.read` on `~/.garrison/sessions/state.json` (initial state).
2. `fs.watch` on the same path.
3. On each `fs.changed` event: `fs.read` again.
The atomic-rename caveat in §5.3 applies; re-read on `added` too,
not only on `modified`.

---

## 11. Future / out of scope for v1

These items are intentionally excluded from the v1 protocol:

- **Application-layer payload encryption.** Tailscale handles
  transport encryption; additional layers are redundant on the
  Tailscale network.
- **Bidirectional file sync.** `vault-sync` (T8) ships
  host → outpost only. Two-way merge is deferred.
- **Per-outpost resource quotas / rate limiting.** Add when a
  measured workload requires it.
- **Multi-host connections per bridge.** One bridge connects to
  exactly one host. Direct bridge-to-bridge is deferred.
- **Bridge auto-update.** Manual: user re-runs bootstrap with a
  newer version.
- **Cross-outpost direct calls.** Host orchestrates each outpost
  independently; "copy file from A to B" routes through the host.
- **`claude.hook` event type.** A dedicated protocol event for
  forwarding Claude Code hook callbacks (UserPromptSubmit,
  PostToolUse, Stop, Notification) was considered as an alternative
  to `fs.watch`-on-state.json for session status detection. The
  `fs.watch` approach requires no new protocol shape and is
  sufficient for v1; `claude.hook` is the natural evolution if
  polling proves too coarse.
- **`exec.run` with large stdout chunking.** No streaming in the
  one-shot path; if output is large, prefer `exec.stream`.

---

## 12. Decisions left to the implementer

These are implementation choices the protocol is agnostic to:

- **WebSocket library on the bridge side (T1):** `ws` vs `undici`.
  Lean: `ws` (stable, widely used, good streaming support).
- **WebSocket server location on the host (T2):** gateway process vs
  dedicated process. Lean: gateway (already long-lived).
- **Token storage on the bridge side (T1):** `config.json` vs macOS
  Keychain. Lean: `~/.garrison-outpost/config.json` for v1.
- **Log rotation (T1):** `winston` vs daily-rotation-file vs stdlib.
  Lean: stdlib `fs` with date-prefixed filenames and a scheduled
  cleanup.
- **Test harness (T1/T2):** how to test the protocol boundary. Lean:
  a mock host that drives the bridge via the protocol (or vice versa).
- **Exact WS endpoint path (T2):** e.g., `/api/outposts/bridge`.
- **Bridge handle format (T1):** UUID v4 or short random hex (e.g.,
  `h-` + 8 hex chars). Either works; pick one and document it in the
  bridge's README.

---

*Protocol version: 1. Produced by Phase 6 T0. Date: 2026-05-11.*
