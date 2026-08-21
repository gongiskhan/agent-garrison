# Remote-shell runtime — attach-and-stream over ssh+tmux, hook-driven lifecycle

**Date:** 2026-08-21
**Status:** Shipped (first transport: the CSG VM over the existing VS Code Dev
Tunnel; live E2E pending the one-time devtunnel login + VM bootstrap).

## Problem

Work happens on machines Garrison does not own — first concretely: a corporate
Windows/WSL VM where the Cursor CLI agent does the work in the employer's repo
and only a Microsoft Dev Tunnel is an acceptable path in. Garrison needs to
attach to that live agent, stream its real TUI two-way into the web channel,
track running/idle honestly, and notify on completion — without the VM ever
opening a connection back to Garrison, and without building anything
CSG-specific.

## Grounding (what the repo already had)

- **Runtime contract** (`gateway-routing.mjs`): engines register in
  `EXEC_ADAPTER_CLASS` (one registry for the primary warm seam and the
  secondary delegate lane), load from `<engine>-runtime/lib/<engine>-adapter.mjs`
  via `resolveSecondaryDir`, and implement `spawn/awaitReady/sendTurn/
  awaitResponse/cancel/teardown`. The secondary lane threads `route.target.model`
  onto `spawnConfig.model` for every exec engine.
- **PTY substrate**: dev-env already runs each PTY as a `tmux attach` CLIENT
  under node-pty (the process lives in the tmux server and survives restarts),
  streams it over the `/io` WS protocol (`init`/`init_ack`/`resize`/bytes), and
  ships a hardened xterm.js `TerminalPane` that has been ported between
  fittings before.
- **Web channel**: the session list is threads with server-owned
  `runningSince`; a thread's opaque `context` travels from the opening URL;
  `POST /notify {title,text,actions,link}` is the uniform channel notification
  contract; a WS/HTTP relay pattern (voice) already exists in its server.

## Decision

One general fitting, `remote-shell-runtime` (Runtimes faculty, own-port 7098
family), no CSG-specific code anywhere:

1. **Transports are config.** A transport = ssh target (+ optional
   `via.devtunnel` tunnel to keep a `devtunnel connect` client alive for) + a
   named tmux session + a remote events file (+ optional `agentCommand`,
   `routingTarget`, `label`). CSG is transport #1; a direct-ssh box (Mac Mini,
   dev-madrid) is the same runtime with a different JSON object.
2. **Attach-and-stream needs NO executor-contract change.** The local node-pty
   child is `ssh -tt <target> tmux attach`; the fitting server speaks dev-env's
   `/io` WS protocol, so the existing terminal-pane component works unchanged.
   The RuntimeAdapter face is a thin loopback-HTTP client of the fitting
   server; the routing target's `model` slot names the TRANSPORT (the same
   one-slot convention Cursor uses for effort-in-model-id), so every routing
   whitelist and UI carries it untouched.
3. **Lifecycle is hook-driven, never scraped.** The remote agent's own hooks
   append `{"event":"agent-start"|"agent-stop"}` lines to a file ON the remote
   machine; the fitting follows it with `tail -F` over the same inbound ssh
   transport, flips running/idle, settles the delegated turn, and fans out the
   channel `/notify` contract. The remote NEVER dials Garrison — a stop hook
   that curls home is exactly the egress profile this design exists to avoid.
4. **Web channel renders the truth.** A thread whose context carries
   `remoteShell: {transport, target?}` gets a real xterm pane over a
   same-origin relay (`/remote-shell/io` + `/api/remote-shell/*` on the
   web-channel server — the browser never sees a cross-port URL, per the
   tailnet HARD RULE), pins the transport's routing target so chat input
   delegates to the remote agent, and the session list marks running from the
   fitting's hook-driven state, so work typed directly into the TUI still
   shows as live. Transports render as one-tap entries ("CSG work").
5. **tmux multi-client sizing:** sessions are created with
   `window-size latest` so vscode.dev and Garrison can attach the same live
   agent without a smaller client shrinking the other; the attach client is
   resized to the connecting terminal pane.

## Consequences / traps

- `devtunnel connect` needs a ONE-TIME interactive `devtunnel user login` on
  the Garrison box with the account that owns the tunnel; the fitting only
  health-checks and (re)spawns the client. An already-healthy forwarded port is
  respected, whoever owns it (a second instance's client, or one run by hand).
- The remote side needs a one-paste bootstrap
  (`scripts/remote-shell/csg-bootstrap.sh`): loopback sshd in WSL, the
  dedicated authorized key, the named tmux session, and agent start/stop hooks
  appending to the local events file.
- `teardown()` after a delegated turn is a NO-OP by design: the session, the
  events watcher, and the remote tmux all outlive turns. Forgetting a session
  (DELETE) only drops the local record — the remote tmux is never killed.
- Turn text is flattened to one line before `tmux send-keys` (Enter submits in
  agent TUIs). Multi-line prompts need bracketed-paste work if ever required.
- Coverage: `tests/remote-shell-runtime.test.ts` (config, hook lifecycle, live
  ssh-to-self attach + adapter turn; live blocks skip where sshd/key are
  absent) and the hermetic Playwright spec under
  `fittings/seed/remote-shell-runtime/ui/__tests__/` (browser typing → remote
  tmux → bytes back).
