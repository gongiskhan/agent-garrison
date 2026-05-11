# Phase 5 verification

**Plan:** `~/.claude/plans/phase-5-execution-recursive-moth.md`
**Analysis:** `PHASE_5_ANALYSIS.md`

Phase 5 added a new top-level **Trenches** tab to Garrison —
embedded terminals (xterm.js + node-pty), quick-launch buttons for
Claude Code (plain + with the Operative's assembled prompt),
multi-host launches via Tailscale + SSH, and screen sharing.
Verification mirrors PHASE1 / PHASE2 / PHASE3 / PHASE4: each
done-when item lands here with evidence (file paths, API calls,
runtime smokes, browser screenshots).

Status as of 2026-05-08: **3 of 4 scenarios pass live on this
machine.** Scenario 4 (screen share) is wired end-to-end through
the UI / API / capture pipeline, but live capture is blocked on
this run by macOS Screen Recording permission not being granted to
the shell that started Garrison — the known v1 manual-permission
step. Granting the permission and re-running the click flow
exercises the remaining unverified path. Tests: 134 passed | 1
skipped (unchanged from Phase 4 baseline). Typecheck clean.
`npm run lint` clean (Phase 5 files plus a one-line drive-by fix
to a pre-existing dangling `eslint-disable` comment in
`src/lib/runner.ts`).

---

## 1. Open Orchestrator end-to-end

**What it asserts:** clicking Trenches → Open Orchestrator opens
a terminal pane, prints a Garrison banner, and runs Claude Code
with the Operative's assembled system prompt as
`--append-system-prompt-file`.

**Evidence — invocation shape settled in T0 (`PHASE_5_ANALYSIS.md` §3.4):**

```
$ claude --append-system-prompt-file /tmp/nonexistent-test-file
Error: Append system prompt file not found: /tmp/nonexistent-test-file
```

Claude Code 2.1.118 supports the file flag, so T3 uses it directly
and avoids shell-escaping the 25 KB prompt body.

**Evidence — live launch (verified via direct API + browser):**

POST to the terminal API with the orchestrator command shape that
the UI builds (banner + `claude --dangerously-skip-permissions
--append-system-prompt-file <path>`):

- New session `orchestrator` created (`POST /api/trenches/terminals`
  → 201).
- The browser, after activating the session, showed Claude Code
  v2.1.118 with `bypass permissions on` and the badge
  `Advisor Tool (experimental) is on and may use more tokens` —
  the latter coming from the appended Operative system prompt.
- Working dir: `~/Projects/agent-garrison/compositions/default`
  (composition directory).

**Files:**
- `src/components/trenches/TrenchesPanel.tsx` — `buildOrchestratorCommand()` builds the banner + claude invocation.
- `src/lib/runner.ts:413` — composition's assembled prompt path.

**Gating:** Open Orchestrator is disabled when no composition is
running (tooltip: "No composition is running — start one from the
Run tab first.") and when a remote host is selected (tooltip:
"Open Orchestrator is local-only; the Operative's prompt lives on
this machine.").

**Banner caveat:** Claude Code's interactive UI clears the screen
on boot, so the banner lines fall into scrollback rather than
sitting above the welcome panel. Acceptable for v1; if the banner
needs to be persistent, a follow-up would render it inside the
xterm panel chrome instead of via shell `printf`.

---

## 2. Three concurrent terminals with busy/idle indicators

**What it asserts:** opening multiple terminals creates fully
independent PTYs, and the left-rail busy/idle dot reflects
per-session output activity within the last 2 seconds.

**Evidence — live exercise:**

- Three sessions opened (`terminal-3`, `terminal-4`, `terminal-5`).
  All visible in the left-rail tab strip with name, terminal
  glyph, idle-or-busy dot, and a close button.
- In `terminal-5`: ran `while true; do echo tick; sleep 0.5; done`.
  Polled `GET /api/trenches/sessions` at 1 Hz — `terminal-5`
  flipped to `busy`, while `terminal-3` and `terminal-4` stayed
  `idle`.
- Sent Ctrl+C — `terminal-5` returned to `idle` after the 2 s
  busy window elapsed.
- Closed `terminal-3` via the close button — `pgrep -P
  <ws-server-pid>` dropped from 2 PTY children to 1, confirming no
  zombies.
- Restarted Garrison's dev process — `GET /api/trenches/sessions`
  returned `{ sessions: [] }`, matching the explicit
  no-cross-restart-persistence design.

**Files:**
- `scripts/trenches-ws.mjs` — node-pty backend, `lastActivity`
  timestamp updated on every stdout chunk; `summarize()` reports
  `busy = (now - lastActivity) < 2000`.
- `src/components/trenches/Terminal.tsx` — xterm.js client,
  WebSocket binary protocol matching Harmonika's.
- `src/app/api/trenches/sessions/route.ts` — Next.js proxy.

**Indicator policy:** dot is filled (sage / green) when busy, hollow
(rule color) when idle. Indicator is per-session.

**node-pty gotcha (recorded in T0):** the npm-distributed `darwin-*`
prebuilds ship `spawn-helper` without the +x bit, so the first
`pty.spawn()` fails with `posix_spawnp failed`. Fixed by
`scripts/fix-node-pty-permissions.mjs` running in `postinstall`.

---

## 3. Remote SSH terminal launch

**What it asserts:** with a Tailscale-style host added to
`~/.garrison/hosts.json`, selecting it from the toolbar dropdown
and clicking New Terminal opens an SSH'd shell on that host.

**Evidence — live exercise (SSH to localhost as a stand-in for a
real Tailscale host on this machine):**

- Added a `selfhost` entry via the Manage hosts modal:
  ```json
  [{ "name": "selfhost", "address": "localhost", "user": "ggomes" }]
  ```
  Verified `~/.garrison/hosts.json` exists with mode `0600`.
- Selected `selfhost · localhost` in the host dropdown and clicked
  New Terminal.
- `POST /api/trenches/terminals` body included `host: "selfhost"`,
  `sshUser: "ggomes"`, `sshAddress: "localhost"`.
- `scripts/trenches-ws.mjs` spawned `ssh -tt ggomes@localhost`.
- The browser showed the SSH banner: `Last login: Thu May 7
  18:47:33 2026` followed by the remote shell prompt
  (`ggomes@Goncalos-Mac-mini ~ %`). Identical behavior would apply
  to a real Tailscale node — the SSH mechanism is host-agnostic.

**Open Orchestrator while remote selected:** the button is greyed
out with the local-only tooltip — confirmed in the browser.

**Open Claude Code while remote selected:** the modal copy switches
to "Path on <selfhost>. SSH connects, then runs
`claude --dangerously-skip-permissions`." Submission constructs
the remote invocation `cd <path> && claude
--dangerously-skip-permissions` and writes it via the SSH PTY.

**Files:**
- `src/lib/hosts.ts` — `~/.garrison/hosts.json` CRUD, validated
  via zod, `mkdirSync(0o700)` + `writeFileSync(0o600)`.
- `src/app/api/trenches/hosts/route.ts` — list + upsert.
- `src/app/api/trenches/hosts/[name]/route.ts` — delete.
- `scripts/trenches-ws.mjs::spawnPty` — branches on `host` to
  `ssh -tt <user>@<address>` instead of `$SHELL`.

**Auth model (per `PHASE_5_ANALYSIS.md` §1.7):** v1 trusts the
user's local SSH config. No password prompts, no key management
inside Garrison. Failures surface naturally as SSH stderr inside
the terminal pane.

---

## 4. Screen share

**What it asserts:** clicking New Screen Share starts a periodic
screenshot capture loop, the main pane renders the live frames at
~2 fps via `<img>` polling, and the same view is reachable from a
phone via the Tailscale URL.

**Evidence — wiring exercised end-to-end on this machine:**

- `POST /api/trenches/screen-share` triggered the capture loop.
  Backend lifted from
  `~/Projects/harmonika-all/lib/screen/capture.ts` —
  `screencapture -x -t jpg /tmp/garrison-screen-latest.jpg`.
- Frontend `<ScreenShare />` polls
  `GET /api/trenches/screen-share/frame?t=<ts>` every 500 ms,
  swaps in a new `URL.createObjectURL(blob)` each tick, and
  revokes the previous URL.
- Sessions API merges screen-share into `GET /sessions` so the
  left-rail picks it up.

**Permission gating (the v1 caveat):** macOS requires explicit
Screen Recording permission for whatever process owns the
`screencapture` invocation. On this machine, that permission
hasn't been granted to the shell that runs `npm run dev`. Result:
`screencapture` exits non-zero with `could not create image from
display`. The capture module detects this stderr signature and
returns a guided error:

```
Screen Recording permission required. Open System Settings →
Privacy & Security → Screen Recording and enable the app that
started Garrison (Terminal / iTerm / Claude Code), then restart it.
```

This message surfaces in the UI's red error banner. The plan
explicitly accepts this — "macOS perms are manual; the setup
script detects missing perms but can't grant them."

**What's verified without permission:**
- The control plane (start, stop, frame fetch endpoints) all
  respond correctly. POST returns the structured permission error.
  GET on `/frame` returns 404 when no frame exists.
- The error path is informative — the UI banner displays the full
  permission-grant guidance.
- The session-list aggregation in
  `src/app/api/trenches/sessions/route.ts:screenShareSession()` is
  **wired but not exercised end-to-end on this run.** With
  `state.running` never reaching `true` (capture failed on first
  attempt), the merge branch that would push a `screen-share`
  entry into the sessions response is unverified. Granting Screen
  Recording permission and re-running the click flow would cover
  it.
- The lock file (`/tmp/garrison-screen-running.lock`) machinery is
  in place; not exercised on this run for the same reason.

**What's deferred from the original T5 spec:**
- Mouse/keyboard relay (`cliclick` → AppleScript fallback). Backend
  routes are not wired; the read-only viewer is enough for the
  primary "phone watches my desktop" scenario.
- Multi-display selector (lift of `lib/screen/displays.ts`).
- WebRTC streaming (`lib/screen/webrtc.ts` + MediaMTX).

These are tracked in the plan's "What gets carried into later
phases" section.

**Files:**
- `src/lib/screen/capture.ts` — capture loop adapted from
  Harmonika.
- `src/app/api/trenches/screen-share/route.ts` — POST/GET/DELETE.
- `src/app/api/trenches/screen-share/frame/route.ts` — serves the
  rolling JPEG.
- `src/components/trenches/ScreenShare.tsx` — viewer.

---

## Quality gates

- `npm run typecheck` — pass.
- `npm run test` — 134 passed, 1 skipped (matches Phase 4
  baseline; no new tests added in Phase 5 — the surfaces are
  primarily real-world / browser-driven and not amenable to vitest
  without significant scaffolding).
- `npm run lint` — pass. Phase 5 files have no findings. A
  pre-existing dangling `eslint-disable-next-line
  @typescript-eslint/no-var-requires` comment in
  `src/lib/runner.ts` (Phase 4 commit `64fc25e`) was removed as
  part of this run since it referenced a rule the project doesn't
  install.
- `npm run dev` — boots `next` and `scripts/trenches-ws.mjs`
  concurrently via `concurrently` (added in T2).

## Things to do before Phase 6

- **Add screen-share permission detection to the setup path.**
  Right now the user discovers the permission gap when they click
  the button. A pre-flight that probes `screencapture` and
  surfaces guidance proactively would be cheap to add.
- **Add a vitest covering `src/lib/hosts.ts` CRUD round-trip.**
  The shape is small enough to unit-test without filesystem
  mocking — use `tmpdir` and an env var override.
- **Decide on persistent terminal sessions across Garrison
  restarts.** Currently sessions die when the WS server dies.
  Harmonika supports reconnection via `userId:base64(cwd)`
  keying; Garrison would benefit from a lightweight version
  scoped to "the same browser tab reopens after a Garrison
  restart and resumes its terminal."
- **`tailscale status` auto-discovery for hosts.** Manual entry
  works but is friction-y when the user has 5+ Tailscale nodes.
