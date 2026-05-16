# Phase 1.1 — Monitor Faculty feasibility audit

**Date:** 2026-05-16
**Scope:** macOS-first observability of every entity Garrison spawns. Linux is a future concern; the discovery shell-outs documented below are tested only on Darwin.

## 1. macOS PID observables — what works and how

### Basic facts (single ps invocation)

```bash
ps -o pid=,ppid=,uid=,etime=,pcpu=,pmem=,stat=,start=,command= -p <pid>
```

Returns one line per PID with no header (`=` suffix suppresses headers). Fields:

| Field | Example | Notes |
|---|---|---|
| `pid` | `6308` | The PID itself. |
| `ppid` | `99201` | Parent PID — used for tree-walk. |
| `uid` | `501` | User; redact for display, useful for filtering. |
| `etime` | `00:00`, `01:23:45`, `7-12:34:56` | Elapsed since spawn. Variable format — parse as `[[D-]HH:]MM:SS`. |
| `pcpu` | `0.0` | Recent CPU %. |
| `pmem` | `0.0` | Recent memory %. |
| `stat` | `Ss`, `S+`, `R`, `Z`, `T` | First char: R(unning), S(leeping), Z(ombie), T(stopped). Used for the Monitor status badge alongside Garrison's own state machine. |
| `start` | `10:05AM` | Wall-clock start time (today) or short date (older). |
| `command` | full argv | Command line — can be very long (Claude Code TUI invocations are 600+ chars). |

### Process tree (descendants)

`pgrep -P <ppid>` lists direct children. For full descendants, run once:

```bash
ps -ax -o pid=,ppid=
```

…and BFS from Garrison's root PID locally. Fast: < 5 ms on a typical macOS system.

### Open ports + network connections

Per-PID:

```bash
lsof -i -P -n -p <pid>
```

Output columns: `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME`. The `NAME` column holds `<addr>:<port> (<STATE>)` where `STATE` is `LISTEN`, `ESTABLISHED`, `CLOSE_WAIT`, etc. Filter LISTEN entries for "open ports"; the rest are active outbound/inbound.

Bulk (all listeners on the system, then filter to descendants by PID):

```bash
lsof -iTCP -sTCP:LISTEN -n -P
```

Both are slow-ish (50–200 ms each); the Monitor backend caches and refreshes on a 1 Hz tick. The brief explicitly accepts polling, not event-driven, for v1.

### Current working directory

```bash
lsof -p <pid> | awk '$4=="cwd"{print $9}'
```

The `cwd` line is always present and gives the absolute path. Faster alternative on macOS: nothing — there is no `/proc` on Darwin, so `lsof` is the canonical path. ~10 ms per call.

### Environment variables

```bash
ps eww -p <pid>
```

The `e` flag appends the process's env to the command-line column; `ww` widens the output so it doesn't truncate. Parse: split on space, treat tokens after the command argv as `KEY=VALUE` pairs. **Redact** any key matching `/(_TOKEN|_KEY|_SECRET|_PASSWORD|^TOKEN$|^SECRET$|^PASSWORD$)/i` before surfacing in the UI.

### Status transitions / exit detection

The `ps` `stat` column shows `Z` (zombie) briefly after exit. The most reliable signal is: PID no longer present in `ps -ax`. The Monitor backend's 1 Hz poll compares current PIDs against the previous tick; any missing PID transitions to `dead` (or `errored` if Garrison's tracked exit-code is non-zero).

### Resource usage

The `pcpu` / `pmem` fields from the standard `ps` line are cheap and sufficient. No need for `top` or `vm_stat` polling.

### Linux parity (deferred)

Same data is reachable via `/proc/<pid>/{stat,status,cmdline,environ,cwd,fd,net}`. The `lsof` shell-out path works on Linux too, just slower. Monitor v1 ships macOS-only; the backend is structured so a Linux adapter is one new file.

## 2. Log capture — recommended strategy: option (a), shared spawn helper

**Decision:** Wrap every Garrison-controlled spawn in a single helper that tees stdout/stderr to `~/.garrison/logs/<pid>/{stdout.log,stderr.log,meta.json}`.

**Three-sentence justification:**

1. There are exactly four Garrison-controlled spawn sites in `src/lib/runner.ts` (`spawnMcpGatewayHttp`, `spawnGateway`, `spawnClaude`, `runShellCommand` + nested `runProcess`); wrapping them is finite, one-time work.
2. Tee-at-spawn is the only way to *retain* the streams; there is no portable post-hoc way to attach to a running process's stdout on macOS (no `/proc`, and `dtrace` requires elevated privileges).
3. Descendants we did not spawn (e.g., a `node` server started inside a workbench terminal by the user) still appear in the Monitor card grid via PID observation — they simply have no captured log content, only metadata, which is honest and acceptable.

**Rejected alternatives:**

- **(b) Sidecar convention** (spawned processes write to a known dir by convention) — relies on cooperation we can't enforce; brittle.
- **(c) Hybrid** — adds complexity without buying anything beyond what (a) + PID observation already covers.

**Layout for the log dir:**

```
~/.garrison/logs/<pid>/
├── stdout.log     # appended live by the spawn helper
├── stderr.log     # appended live by the spawn helper
└── meta.json      # written once at spawn time
```

`meta.json` shape:

```json
{
  "pid": 12345,
  "command": "node",
  "args": ["scripts/server.mjs"],
  "cwd": "/Users/.../composition",
  "parentPid": 6308,
  "spawnedAt": "2026-05-16T10:30:00.000Z",
  "env": { "NODE_ENV": "development", "PORT": "50321" },
  "spawnSite": "spawnGateway"
}
```

`env` is redacted (token/key/secret/password keys removed) before serialization.

**Retention:** delete `~/.garrison/logs/<pid>/` when the PID is observed `dead` for more than 24 h. Cleanup is a Monitor backend responsibility, not the spawn helper's.

## 3. Port allocation convention for UI Fittings

**Decision:** Each UI-bearing Fitting declares a **default port** in its `apm.yml`'s `x-garrison.ui.port` field. At start time the Fitting tries to bind that default; if the port is in use, it picks the next free port via the existing `findFreePort` helper and writes the chosen port to `~/.garrison/ui-fittings/<fitting-id>.json` for consumers to discover.

**Status file shape (`~/.garrison/ui-fittings/<fitting-id>.json`):**

```json
{
  "fittingId": "monitor",
  "port": 7077,
  "url": "http://localhost:7077",
  "pid": 12345,
  "startedAt": "2026-05-16T10:30:00.000Z"
}
```

**Consumer discovery:** UI-Fitting consumers (e.g., the chat UI) read `~/.garrison/ui-fittings/monitor.json`. If absent or `pid` is dead, treat as unavailable. If present, `GET <url>/health` to confirm reachability before linking.

**Monitor Fitting default port:** `7077`. Chosen to be outside common dev port ranges (3000–9999 are crowded) and the worktree pool (50000–54999). Memorable. Not used by any well-known service.

**Rejected alternatives:**

- **Fully fixed ports** — fails on conflicts. Annoying when the user has a global service on the chosen port.
- **Pure runtime allocation** with no default — consumers can't predict the URL; needs a registry call.
- **Config-declared only** — too much ceremony for a single-user local-first tool.

**Future UI Fittings** (e.g., a documents-viewer, the chat UI itself) follow the same pattern: pick a default port, write a status file, fall back to dynamic if the default is taken. Documented in `docs/UI-FITTINGS.md` (Phase 1.7 deliverable).

## 4. Final decisions to record in `docs/DECISIONS.md`

(Phase 1.2 will copy these into `DECISIONS.md` with proper formatting.)

1. **macOS-first Monitor discovery via `ps` + `lsof`** — no `dtrace`, no `/proc` (not present on Darwin). Linux adapter deferred.
2. **Shared spawn helper at `src/lib/spawn.ts`** — wraps the 4 `runner.ts` spawn sites; tees stdout/stderr + writes redacted `meta.json` under `~/.garrison/logs/<pid>/`. node-pty terminal sessions are NOT wrapped (they have their own pipeline and the user owns their terminals).
3. **UI Fitting port convention** — default in `x-garrison.ui.port`; dynamic fallback via `findFreePort`; chosen port published at `~/.garrison/ui-fittings/<id>.json`. Monitor default: `7077`.
4. **Log retention** — 24 h after the PID is observed dead; Monitor backend handles cleanup.
