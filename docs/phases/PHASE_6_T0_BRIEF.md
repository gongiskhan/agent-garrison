# Phase 6 T0 — Outpost Protocol Design

You are designing the wire protocol for Garrison's Outposts Faculty.
This is Phase 6 ticket T0. The canonical spec lives in
`GARRISON_ROADMAP.md` Phase 6 §, and the execution plan is in
`PHASE_6_EXECUTION.md`. Both should be in the repo.

This brief is self-contained. §11 is the contract.

## 0. Pre-context

Phase 5 (Armory) is complete. The Operative runs on the user's
**automation machine** (Mac Mini M4, 16 GB RAM, always on). The
user wants to use Garrison's Armory composition from their
**development machine** (MacBook Pro M1 Max, 32 GB RAM, always on)
without running a second Garrison instance. The **portable
machine** (MacBook Air M4, 16 GB RAM, intermittent uptime) joins
the same setup but may be offline at any time.

The bridge architecture: each remote Mac runs a small daemon
(`garrison-outpost-bridge`) that opens a persistent WebSocket
connection to the host (automation machine). The host's Garrison
sends RPC requests; the bridge executes them and streams events
back.

T0 is **design**, not implementation. The output is a committed
markdown document. No code changes in this ticket.

## 1. Time budget

This is a 90-minute timer ticket. If the design doesn't feel solid
by then, the human is falling back to cloning Garrison onto the
development machine and shipping Phase 6 properly in a later
session.

**The goal is a document complete enough that T1 (bridge daemon)
and T2 (host Fitting) can be implemented independently against the
same spec, by different people if needed.**

## 2. Output

A single committed file: `PHASE_6_PROTOCOL.md`.

Markdown. Should be readable in 10 minutes by someone who hasn't
seen the roadmap. Examples preferred over prose.

## 3. Required content

### 3.1 Transport

Confirm WebSocket over Tailscale. Brief justification (debuggable,
no proto compilation, native reconnect semantics, gRPC's tooling
overhead not justified at the scale Garrison will hit). Don't dwell
on this; the decision is already in the roadmap.

### 3.2 Message envelope

Every message is a JSON object with a fixed envelope. Pick the
exact field names. Likely shape:

```json
{
  "version": 1,
  "type": "process.spawn",
  "id": "abc123",
  "payload": { ... }
}
```

Decide:
- `version` placement (top-level vs in handshake only).
- `id` semantics: required for RPC requests; absent for events;
  echo-back rule for responses.
- `type` namespace conventions (`namespace.operation`).
- How errors are framed (`type: "error"` vs `error` field inside
  a response — pick one).

### 3.3 Operation namespaces

Document every operation. For each: the `type` string, request
`payload` schema, response shape (or stream-of-events shape), and
errors that can be raised.

Required operations for v1 (don't add more):

**process.**
- `process.spawn { command, args[], cwd?, env? } → { pid }`
- `process.kill { pid, signal? } → { ok }`
- `process.send_input { pid, input } → { ok }`
- `process.list {} → { processes: [{pid, command, started_at}] }`
- `process.status { pid } → { pid, running, exit_code? }`

**fs.**
- `fs.read { path, encoding? } → { content }`
- `fs.write { path, content, encoding? } → { ok }`
- `fs.list { path } → { entries: [{name, type, size}] }`
- `fs.exists { path } → { exists, type? }`
- `fs.mkdir { path, recursive? } → { ok }`
- `fs.delete { path, recursive? } → { ok }`
- `fs.watch { path, recursive? } → { watch_id }`
- `fs.unwatch { watch_id } → { ok }`

**git.**
- `git.list_worktrees { repo_path } → { worktrees: [...] }`
- `git.create_worktree { repo_path, branch, target_path } → { path }`
- `git.delete_worktree { worktree_path } → { ok }`
- `git.status { worktree_path } → { branch, dirty, ahead, behind }`

**exec.**
- `exec.run { command, cwd?, env?, timeout_ms? } → { stdout, stderr, exit_code }`
- `exec.stream { command, cwd?, env? } → stream of events`

### 3.4 Event types (bridge → host, unsolicited)

- `process.output { pid, stream: "stdout"|"stderr", data }`
- `process.exit { pid, exit_code, signal? }`
- `fs.changed { watch_id, path, kind: "added"|"modified"|"removed" }`
- `connection.heartbeat { timestamp }`

For each: the exact payload shape. How events correlate to RPC
operations (via `pid`, `watch_id`, or operation `id`).

### 3.5 Auth handshake

First message after WebSocket open:

```json
{ "type": "auth", "token": "...", "machine_name": "development" }
```

Bridge responds:

```json
{ "type": "auth_ok", "protocol_version": 1, "bridge_version": "0.1.0" }
```

Or, on failure:

```json
{ "type": "error", "code": "unauthorized" }
```

Specify:
- Token format (the host generates 32 random bytes, hex-encoded — confirm).
- What happens if auth fails (host closes the connection; bridge
  retries with backoff but logs auth failures distinctly so a
  rotated token doesn't silently retry forever).
- Protocol version mismatch behavior (immediate close with
  `protocol_version_mismatch` error code).

### 3.6 Reconnect strategy

The **bridge** initiates reconnects. Specify:
- Exponential backoff: start at 1s, double up to 60s max. Jitter
  ±20% to avoid thundering-herd.
- Auth replay on reconnect — same token, same machine name.
- State recovery: on reconnect, what survives?
  - In-flight RPCs initiated before disconnect: **lost.** Caller
    must retry. Bridge does not buffer.
  - Active fs watches: **lost.** Host must re-subscribe after
    reconnect. Bridge surfaces a `connection.reconnected` event
    to nudge the host.
  - Spawned processes: **survive.** They're real OS processes
    independent of the bridge process (modulo the bridge process
    itself dying — different concern). On reconnect, the host
    can call `process.list` to see what's still running.
- Max reconnect attempts: none. Bridge retries forever (with
  capped backoff). User shuts the bridge down explicitly.

### 3.7 Heartbeat / liveness

- Every 30 seconds, the bridge sends `connection.heartbeat`.
- The host considers the connection dead if it doesn't see a
  heartbeat for 90 seconds. Closes the socket; bridge reconnects.
- Why bridge sends rather than host pings: simpler. Bridge owns
  its uptime; host watches.

### 3.8 Operation cancellation

- The host can send `{ "type": "cancel", "id": "..." }` to abort
  an in-flight RPC.
- Best-effort: if the operation has already completed when cancel
  arrives, the response goes back as if cancel never happened.
- For `exec.stream` and similar long-running ops, cancel sends
  SIGTERM to the spawned process and emits `process.exit` with
  the appropriate signal.

### 3.9 Error code enum

Fixed list. Pick the names:
- `unauthorized` — bad token, expired session.
- `not_found` — file/process/worktree doesn't exist.
- `permission_denied` — fs permission, sudo required, etc.
- `protocol_version_mismatch` — version mismatch at handshake.
- `operation_failed` — generic "the underlying command failed."
  Include the underlying message/exit code in the error payload.
- `timeout` — operation took too long (only when `timeout_ms` was
  specified on the request).
- `cancelled` — operation was cancelled via the cancel message.
- `invalid_payload` — request didn't match the schema.

Document each: what the bridge returns it for, what the host
should do when it sees it.

### 3.10 Worked example

A full wire trace for **create a worktree and open a terminal in
it on the development machine.** Show every message in both
directions, with timing assumptions. This is the most important
section of the doc — if anything in the design is incoherent, it
shows up here.

The trace should cover:
1. Bridge initial connect + auth.
2. Host RPC: `git.create_worktree`.
3. Bridge response.
4. Host RPC: `process.spawn` for a shell in the worktree dir.
5. Bridge `process.output` events as the shell starts.
6. Host RPC: `process.send_input` (user types a command).
7. More `process.output` events.
8. Host RPC: `process.kill`.
9. Bridge `process.exit` event.

Keep it tight — one screen if possible.

## 4. Non-required but worth mentioning

A short "Future / out of scope for v1" section listing things the
protocol intentionally doesn't address yet:

- Encrypted application-layer payloads (Tailscale already handles
  transport encryption).
- Bidirectional file sync.
- Resource quotas / rate limiting per outpost.
- Multi-host connections from one bridge (one bridge connects to
  exactly one host).
- Auto-update.
- Cross-outpost direct calls.

These belong in the roadmap's parking lot, not in the protocol
spec itself — but listing them in the doc helps future readers
know what's intentional.

## 5. Decisions left to the implementer

Don't try to settle these in T0:

- WebSocket library on the bridge side (`ws` vs `undici` —
  T1 decides).
- WebSocket server location on the host (gateway vs separate
  process — T2's open question).
- Token storage on the bridge side (config file vs keychain —
  T1 decides; lean config file).
- Log rotation library (T1).
- Test harness shape (T1/T2).

These are implementation choices. The protocol spec should be
agnostic.

## 6. Style

- Markdown headings: `##` for sections, `###` for subsections.
- Code blocks for every JSON shape.
- One example per operation. Don't exhaustively document every
  edge case — the implementers will discover them and the spec
  will evolve.
- No "TBD" or "we'll figure this out later." If you can't decide,
  pick the lean option and move on. The protocol is v1; v2 will
  fix what hurts.

## 7. Time discipline

The user has a 90-minute timer. Inside that budget:

- ~15 min: skim the existing `GARRISON_ROADMAP.md` Phase 6 section
  and `PHASE_6_EXECUTION.md` T0 section to anchor on the agreed
  shape.
- ~50 min: draft the operations, events, handshake, reconnect,
  errors. Write the worked example as you go — that's where bugs
  in the design surface.
- ~15 min: review, tighten, commit.
- ~10 min: buffer for surprises.

If you're at 75 minutes and still wrestling with a section, **cut
that section** to "v1: simplest thing that could work; revisit on
first contact." Don't burn budget on details that the first
implementation pass will inform anyway.

## 8. What "feels solid" means at the 90-minute mark

The doc is solid if:

- Someone could read it cold and start implementing the bridge
  side (T1) without asking clarifying questions about the wire.
- The worked example in §3.10 compiles in your head — every
  message has a sender, a recipient, an effect, and an obvious
  next step.
- You don't have nagging "but what about X" questions about auth
  or reconnect.

The doc is **not** solid if:

- Section 3.10 doesn't write itself, because the operations
  don't compose correctly.
- You're inventing payload shapes inline as you write the worked
  example.
- You're hedging language ("probably," "maybe," "depending on")
  on core mechanics like auth or error framing.

If 3.10 doesn't write cleanly, the rest of the design has a hole.
Don't ship the doc — fall back to cloning Garrison on the
development machine, and revisit T0 in a later session with the
implementation hole identified.

## 9. Commit

When done:
- Path: `PHASE_6_PROTOCOL.md` at the repo root.
- Commit message: "design: outpost protocol v1 spec"
- Don't update the roadmap or execution plan in this ticket; the
  protocol spec is its own document.

## 10. What's NOT in this ticket

- Code. No bridge implementation. No host Fitting. No tests.
- Architecture diagrams. Markdown text + JSON examples are enough.
- Performance benchmarks. Worry about throughput when there's a
  workload.
- Cross-protocol compatibility (HTTP fallback, etc.).
- Authentication beyond a static token.
- Multi-tenancy.

## 11. Definition of done

- `PHASE_6_PROTOCOL.md` exists at the repo root.
- Contains every required section from §3.
- The worked example in §3.10 traces a coherent create-worktree +
  spawn-shell + send-input + kill flow with all messages shown.
- A reader unfamiliar with the design can answer: "what's the
  envelope, what are the operations, how does auth work, what
  happens on reconnect, how are errors framed" — by reading the
  doc alone.
- Committed with the message above.

If after 90 minutes the doc doesn't meet the bar, **stop and
report what's blocking**. The human will decide whether to push
through, commit a partial spec with the gaps flagged, or fall
back to Option A (clone Garrison to development).
