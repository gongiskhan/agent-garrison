# Phase 5 analysis

**Plan:** `~/.claude/plans/phase-5-execution-recursive-moth.md`

Phase 5 adds a "Trenches" main tab to Garrison: embedded terminals
(xterm.js + node-pty), quick-launch buttons for Claude Code,
multi-host launches via Tailscale + SSH, and screen sharing.
**Phase 5 is a port, not a design exercise** — the working
implementations live in Harmonika at
`/Users/ggomes/Projects/harmonika-all`. This doc captures the
decisions that shape the port and records the empirical checks the
plan called for in T0.

Status as of 2026-05-08: all five decisions resolved, all four
empirical checks pass. T3's launch shape settled — `--append-system-prompt-file`
exists in Claude Code 2.1.118, so the file flag is preferred over
shell-substituted `--append-system-prompt "$(cat ...)"`.

---

## 1. Pre-resolved decisions

### 1.1 Files to lift from Harmonika

See "Harmonika source map" (§2) below for paths and one-line
descriptions per file. v1 lifts the screenshot path
(`lib/screen/capture.ts`, `displays.ts`, screenshot endpoints) and
defers WebRTC streaming (`lib/screen/webrtc.ts`, MediaMTX +
ffmpeg) to a later phase.

### 1.2 Screen-share approach: periodic screenshots

Harmonika has both screenshots (1 fps JPEG, click/keyboard relay)
and WebRTC streaming (h264 + MediaMTX). Phase 5 ships **screenshots
only.** Rationale: simpler dependency surface (no MediaMTX binary,
no ffmpeg), battle-tested by the user, and adequate for the
primary scenario ("phone watches my desktop"). WebRTC remains a
clean lift later if smoother streaming matters.

### 1.3 Terminal busy-detection heuristic: `lastActivity` timestamp

Lift Harmonika's pattern from `server/terminal.js`. Each PTY
records a `lastActivity` timestamp updated on every stdout chunk.
Indicator = `busy` when `now - lastActivity < 2000ms`, else `idle`.
Surface via `GET /api/trenches/sessions` polled at ~1Hz from the
left-rail tab strip.

### 1.4 Hosts file location: `~/.garrison/hosts.json`

Per-user global, not per-composition. Precedent: Phase 2's
google-calendar already writes `~/.garrison/google-calendar/token.json`,
so the dir exists. Phase 5 adds the **first general-purpose
user-scoped file** (`hosts.json`). Future user-scoped state
(preferences, multi-machine sync) lands in the same dir.

### 1.5 Default Claude Code flags: `--dangerously-skip-permissions`

Matches the user's `~/.claude/CLAUDE.md` trust context (solo
developer machine, single user owns everything under `~/Projects`).
Configurable via `~/.garrison/preferences.json` per-user; default
ships with the flag enabled. Open Orchestrator additionally appends
`--append-system-prompt-file <composition-dir>/.garrison/assembled-system-prompt.md`
(see §1.6).

### 1.6 T3 launch invocation: `--append-system-prompt-file`

The Claude Code CLI exposes `--append-system-prompt-file <path>`
(version 2.1.118; documented in the `--bare` flag's help text and
empirically confirmed — see §3.4). T3 uses the file flag and
sidesteps shell-escaping concerns entirely. Fallback path
(`--append-system-prompt "$(cat ...)"`) is no longer needed.

### 1.7 Auth / threat model for Trenches endpoints

T2's terminal WebSocket and T5's screen-share endpoints are
network-reachable when Garrison is exposed via Tailscale (the
explicit "open from phone" scenario). **Auth model: trust Tailscale
at the network layer. No app-level auth.** Matches the CLAUDE.md
solo-machine trust context — Tailscale's WireGuard mesh is the
only network these endpoints should be reachable on.

**Concrete bind rules:**
- Garrison currently binds to `127.0.0.1:3000` (`package.json`
  scripts: `next dev -H 127.0.0.1 -p 3000`). Trenches inherits.
- The terminal WS process should bind to `127.0.0.1` plus the
  Tailscale interface (or `0.0.0.0` only when a Tailscale-aware
  user opt-in is set in `~/.garrison/preferences.json`).
- Default: **do not bind to `0.0.0.0`.** LAN exposure requires an
  explicit user choice.

If a later phase introduces multi-user Garrison or untrusted
network exposure, T2/T5 will need app-level auth retrofitted —
flagged here so it isn't quietly forgotten.

---

## 2. Harmonika source map

### Terminal (T2 lifts)

| Harmonika path | Bytes | Notes |
| --- | --- | --- |
| `components/terminal/XtermWrapper.tsx` | 16 180 | xterm 5.5.0 client. Binary WebSocket protocol: text frames = JSON control (`init`, `resize`, `ping`), binary frames = stdin/stdout. Mobile-aware sizing — drop for v1. |
| `components/terminal/MobileTerminalToolbar.tsx` | — | Optional, mobile modifier-key support. Skip in v1. |
| `server/terminal.js` | 20 703 | PTY backend. node-pty 1.1.0, ws 8.18.0. Persistent session map keyed `userId:base64(cwd)` (drop the userId scope; Garrison is single-user). 5-min PTY idle timeout, 10KB stdout buffer for transient WS reconnects, `lastActivity` timestamp tracking. |

### Screen share (T5 lifts)

| Harmonika path | Bytes | Notes |
| --- | --- | --- |
| `lib/screen/capture.ts` | 10 134 | `screencapture -x -t jpg -D{displayId}` driver on macOS. Output: `/tmp/harmonika-screen-latest.jpg`, JPEG quality 85, 1s interval. Lock file `/tmp/harmonika-screen-running.lock` for cross-reload state. Permission detection + System Settings guidance built in. |
| `lib/screen/displays.ts` | 6 203 | `system_profiler SPDisplaysDataType -json` parser. Returns `DisplayInfo[]` with id, resolution, refresh rate, isMain, online flags. |
| `lib/screen/mjpeg.ts` | — | Async generator for MJPEG streaming; optional, can defer. |
| `app/api/screen/click/route.ts` | 5 962 | Mouse relay. Tries `cliclick` (preferred), AppleScript `tell application "System Events" to click at {x,y}` fallback. |
| `app/api/screen/keyboard/route.ts` | 6 004 | Keyboard relay via `cliclick` (`t:text`, `kp:key`, `kd/ku:modifiers`). Browser key-name mapping table. |
| `app/repo/[repoId]/screen/page.tsx` | — | Frontend viewer: double-buffered (instant z-index swap), 1–2.5s polling, click-to-control with letterbox-aware coord mapping. Adapt to render inside Trenches main pane. |

### Deferred for later phases

`lib/screen/webrtc.ts` (h264 + MediaMTX + ffmpeg) — heavier
dependency surface, only matters when smoother streaming becomes a
hard requirement.

---

## 3. Empirical validation

### 3.1 node-pty builds against Garrison's Node version

**Result: PASS.** Garrison runs Node v22.22.0. Harmonika has
node-pty 1.1.0 already built at
`/Users/ggomes/Projects/harmonika-all/node_modules/node-pty`.
`node -e "require('.../node-pty')"` loads cleanly under Node
22.22.0 — the prebuilt native binary is ABI-compatible.

**Implication:** adding `node-pty: ^1.1.0` to Garrison's
`package.json` should build cleanly via `npm install`. If a
later Node upgrade breaks ABI, add a `postinstall` script that
runs `npm rebuild node-pty`.

### 3.2 Harmonika terminal still works end-to-end

**Result: PASS (proxied).** Full Harmonika boot was not exercised
during T0 — Harmonika and Garrison both bind to overlapping ports
and would conflict. Proxy evidence:

- All claimed source files exist at the documented paths and sizes
  (verified via `ls -la`).
- node-pty native binary loads under Garrison's Node version
  (§3.1).
- Harmonika package.json declares the exact dependency versions
  the lift will pin: `node-pty ^1.1.0`, `@xterm/xterm ^5.5.0`,
  `@xterm/addon-fit ^0.10.0`, `@xterm/addon-web-links ^0.11.0`,
  `ws ^8.18.0`.

Full smoke (boot Harmonika, open a terminal in the browser) is
deferred to T2's verification step, where the lifted code runs
inside Garrison.

### 3.3 Harmonika screen-share primitives available

**Result: PASS.**

- `screencapture` at `/usr/sbin/screencapture` (macOS built-in).
- `cliclick` at `/opt/homebrew/bin/cliclick` (Homebrew).
- `system_profiler SPDisplaysDataType -json` returns valid display
  data on this machine (Apple M4, primary display 1920×1080
  @ 60Hz, `spdisplays_main: yes`).
- `xdotool` not present (Linux-only path; macOS uses cliclick).
  Out-of-scope per plan.

macOS Screen Recording permission already granted (user has been
running Harmonika historically). T5 will detect missing perms via
Harmonika's existing error-string detection in `capture.ts`.

### 3.4 T3 launch invocation: `--append-system-prompt-file` exists

**Result: PASS — file flag wins.**

```
$ claude --append-system-prompt-file /tmp/nonexistent-test-file
Error: Append system prompt file not found: /tmp/nonexistent-test-file
```

The CLI accepts the flag and reaches the file-read step (errors
because the path doesn't exist), confirming `--append-system-prompt-file`
is implemented in Claude Code 2.1.118. The flag is also documented
in the `--bare` flag's help text:

> Explicitly provide context via: --system-prompt[-file],
> --append-system-prompt[-file], --add-dir (CLAUDE.md dirs),
> --mcp-config, --settings, --agents, --plugin-dir.

**Garrison's assembled prompt size:** 25 343 bytes (25 KB) at
`compositions/default/.garrison/assembled-system-prompt.md`. Well
under macOS `ARG_MAX` (256 KB), but the file flag bypasses that
constraint regardless.

**T3 invocation (final):**
```
claude --dangerously-skip-permissions \
  --append-system-prompt-file <composition-dir>/.garrison/assembled-system-prompt.md
```

No shell quoting concerns. No size ceiling.

---

## 4. Surprises and "lift with rewrites" callouts

**Concrete surprise — node-pty `spawn-helper` lacks +x bit.** When
node-pty 1.1.0 is installed via npm registry on this machine, the
prebuilt `prebuilds/darwin-arm64/spawn-helper` binary lands without
the executable bit. Calling `pty.spawn()` fails with
`Error: posix_spawnp failed.` Fix: a `postinstall` script
(`scripts/fix-node-pty-permissions.mjs`) chmods the helpers
on every `npm install`. Cost: tiny. Discovered during T2; this is
the kind of friction that would otherwise eat 30 minutes of
"why doesn't the shell spawn" debugging.

None of the structural lifts require rewrites. Adaptations
required:

- **PTY session keying.** Harmonika keys `persistentPtys` by
  `userId:base64(cwd)`. Garrison is single-user; drop the userId
  scope, key by session id only.
- **WebSocket transport.** Next.js App Router doesn't support raw
  WS in route handlers. T2 mounts a sibling Node WS process
  (port 3501 in Harmonika; pick a Garrison-specific port to
  avoid collision when both run side-by-side).
- **Display selector storage.** Harmonika persists selected
  display to `/tmp/harmonika-screen-display.txt`. Garrison should
  use `~/.garrison/preferences.json` instead — keeps user-scoped
  state in one place.
- **Screen-share output path.** Harmonika writes to
  `/tmp/harmonika-screen-latest.jpg`. Garrison should use
  `/tmp/garrison-screen-latest.jpg` or namespace under
  `/tmp/garrison/` to avoid stomping if both apps run.
- **Mobile toolbar.** Harmonika has `MobileTerminalToolbar.tsx`
  for on-screen modifier keys. Drop for v1 (desktop-first).

**No license blockers.** Harmonika code is the user's own work;
xterm.js, node-pty, ws are all MIT.

---

## 5. Decisions ready for T1+

| Question | Answer |
| --- | --- |
| Sidebar placement | Main tab alongside Garrison / Compose / Armory / Run / Chat / Vault. Add via `<NavLink>` at `src/components/chrome/Sidebar.tsx:99-105` pattern. |
| Page route | `src/app/trenches/page.tsx` |
| Component dir | `src/components/trenches/` |
| API base | `src/app/api/trenches/` |
| Terminal WS | Sibling Node process at `scripts/trenches-ws.js`, port TBD in T2 (avoid 3501 to allow Harmonika coexistence) |
| node-pty install | `package.json` deps (core, not Fitting setup hook) |
| Active composition | Whichever composition is currently `up()` via Run tab. Open Orchestrator disabled when none running. |
| Hosts file | `~/.garrison/hosts.json`, schema in plan §T4 |
| Default flags | `--dangerously-skip-permissions`; configurable via `~/.garrison/preferences.json` |
| Open Orchestrator launch | `claude --dangerously-skip-permissions --append-system-prompt-file <path>` |
| Bind interface | `127.0.0.1` + Tailscale interface; `0.0.0.0` requires user opt-in |
| Screen-share frame path | `/tmp/garrison-screen-latest.jpg` |
| Screen-share approach | Periodic screenshots (~2 fps polling). WebRTC deferred. |
| Busy/idle | `now - lastActivity < 2000ms` |
