# G6 (partial): devtunnel host instability - mitigation, live-verified on csg

Not the full G6 scope (that is unstarted - see PROGRESS.md). This is a targeted fix for a real,
concrete problem the operator hit live tonight while manually bringing the `swift-book-df6tw47.eun1`
VS Code tunnel back up on csg, and asked to have mitigated as part of this work.

## The problem, verbatim from the operator's terminal

`devtunnel host swift-book-df6tw47.eun1` run in a foreground terminal on csg showed a repeating
pattern: the relay connection drops and reconnects on its own (`Connection to host tunnel relay
closed... Reconnecting... Connection to host tunnel relay restored.` - this part is self-healing, the
CLI handles it), interspersed with `Warning: Approaching limit for 'BandwidthPerUser' (101%)`, and
eventually a fatal `Error connecting host tunnel session: Not authorized...Unauthorized. Refreshed
tunnel access token is not valid` that the process does NOT recover from on its own - it needed a
manual `pkill -f "devtunnel host"` + re-run. `devtunnel host` has no daemon mode and no built-in
restart, and the operator's session was a foreground terminal, so the tunnel goes dark exactly when
nobody is watching, until someone notices and reruns it by hand.

## The fix

`scripts/remote-shell/devtunnel-host-supervisor.sh <tunnel-id> [log-dir]` - a POSIX `sh` restart-loop
supervisor (no bashisms; passes `sh -n` and `dash -n`):

- Runs `devtunnel host <tunnel-id>` via `setsid ... &` (detaches from any controlling terminal - a
  closed terminal no longer takes the tunnel down) and `wait`s on the child's real PID (not a job
  number), so signal handling and exit-code capture are exact.
- On exit for ANY reason (crash, the 401 token-refresh failure, a manual kill), restarts after a
  backoff: 2s base, doubling to a 60s cap on repeated fast failures, reset to 2s once a run has been
  stable for >= 60s - a classic crash-loop guard, not a fixed retry count.
- Logs everything to `<log-dir>/<tunnel-id>.log` (self-rotating past 2MB, keeps the tail), and writes
  one JSON status line to `<tunnel-id>.state` (`starting`/`restarting`/`stopped`, restart count, last
  exit code, how long the last run lasted) - a caller can poll the state file instead of parsing the
  raw devtunnel log.
- Separately flags a recent `BandwidthPerUser` warning in its own log line (not itself fatal, but
  useful context for why the next disconnect happened) rather than leaving it buried in scrolling
  relay noise.
- `INT`/`TERM` on the supervisor cleanly kills its current child and writes `state: stopped` before
  exiting - so the supervisor process itself is one thing to stop, not two.

## Live verification on csg (dev-madrid -> `devtunnel connect swift-book-df6tw47.eun1` -> ssh -p 2222)

1. Confirmed the tunnel the operator had just brought up was live:
   `devtunnel show swift-book-df6tw47.eun1 --json` -> `hostConnections: 1`.
2. Established a working SSH session through it (`ssh -p 2222 -i ~/.ssh/garrison-remote-shell
   ggomes@127.0.0.1`) - confirmed csg's real identity (`AZR-IMvwYA5CQHr`, WSL2 kernel
   `6.18.33.2-microsoft-standard-WSL2`), matching the plan's research appendix exactly.
3. Copied the script to csg, installed it at `~/.garrison/scripts/devtunnel-host-supervisor.sh`,
   killed the operator's manual foreground `devtunnel host` process, and started the supervised
   version detached (`DEVTUNNEL_BIN=/home/ggomes/.local/bin/devtunnel nohup setsid
   .../devtunnel-host-supervisor.sh swift-book-df6tw47.eun1 &` - the full path is needed because a
   non-interactive ssh exec has no login-shell PATH, so a bare `devtunnel` is not found; same trap the
   Shells lister/cursor probe code already works around elsewhere in this plan).
4. The kill briefly dropped my own SSH session (expected - it rides the very tunnel being replaced);
   reconnected within seconds once the supervisor's fresh `devtunnel host` came up. State file read
   `{"state":"starting","restarts":0}`.
5. **Simulated the exact failure the operator hit**: `kill -9` on the supervised `devtunnel host`
   child PID. My SSH session dropped again (same reason); reconnected automatically a few seconds
   later. State file now read `{"state":"starting","restarts":1}`. Log confirmed the full cycle:
   `exited after 41s (code 137)` [137 = SIGKILL] -> the BandwidthPerUser note -> `starting... (attempt
   2)` 4 seconds later (2s base backoff doubled once, since the prior run was under the 60s stable
   threshold) -> a fresh `Ready to accept connections for tunnel: swift-book-df6tw47.eun1`.

This proves the mitigation works end to end against the REAL failure mode, not a synthetic one: a
crash of `devtunnel host` self-heals in seconds instead of needing a human to notice a dead terminal
and rerun a command by hand.

## What this is NOT

Not a fix for the bandwidth quota itself (a Microsoft relay-side limit outside Garrison's control -
the warning recurred immediately on the very first restart, meaning the tunnel is basically always
near its ceiling; the mitigation is resilience to the disconnects that quota pressure causes, not
elimination of the quota pressure). Not persistent across a WSL/csg reboot (no systemd unit / node
process supervisor on csg yet - that is exactly what `node-supervisor.sh` + G7's install will add;
until then this is a `nohup`-backed background process the operator can restart by hand the same way
if csg itself restarts). Not yet wired into `TetherManager` or any Garrison fitting code - it is a
standalone operational script, deployed and running on csg right now, independent of whether the rest
of G6 (the tether manager class, preflight scripts, installer) gets built this session.
