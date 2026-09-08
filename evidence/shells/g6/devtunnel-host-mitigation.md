# G6 (partial): devtunnel host instability - the fix, a correction, and a live lockout

Not the full G6 scope (that is unstarted beyond what's listed here and in PROGRESS.md). This started
as a targeted fix for a real, concrete problem the operator hit live tonight while manually bringing
the `swift-book-df6tw47.eun1` VS Code tunnel back up on csg, and ended in a real lockout worth reading
carefully before anyone repeats the swap that caused it.

## The problem, verbatim from the operator's terminal

`devtunnel host swift-book-df6tw47.eun1` run in a foreground terminal on csg showed a repeating
pattern: the relay connection drops and reconnects on its own (self-healing - the CLI handles it),
interspersed with `Warning: Approaching limit for 'BandwidthPerUser' (101%)`, and eventually a fatal
`Error connecting host tunnel session: Not authorized...Unauthorized. Refreshed tunnel access token is
not valid` that the process does NOT recover from on its own - it needed a manual
`pkill -f "devtunnel host"` + re-run. `devtunnel host` has no daemon mode and no built-in restart, and
the operator's session was a foreground terminal, so the tunnel goes dark exactly when nobody is
watching.

## First attempt: a new restart-loop script (superseded - see below)

Wrote `scripts/remote-shell/devtunnel-host-supervisor.sh`, a POSIX restart loop keyed on PROCESS
EXIT: detach via `setsid`, `wait` on the real child pid, backoff 2s->60s with a stable-run reset, log
rotation, a JSON state file. Deployed it to csg, killed the operator's manual session, verified it
recovered automatically, then simulated the operator's exact failure (`kill -9` the child) and
confirmed auto-recovery in seconds (`restarts: 1` in the state file, ~4s later a fresh
`Ready to accept connections`).

**This script has a real gap, found before it was needed the hard way**: `fittings/seed/remote-shell-
runtime/scripts/host-tunnel.sh` already exists in this repo, is more mature, and is covered by
`tests/remote-shell-host-tunnel.test.ts` - whose own docstring records the EXACT failure a process-
exit restart loop cannot catch: *"a restart loop already existed on the CSG box and had been 'healthy'
for thirty hours while the tunnel carried nothing: `devtunnel host` does NOT exit when the relay drops
it ('Another host for the tunnel has connected.'), it stays alive, hosting nothing."* Liveness is not
health - the same lesson `forwards.mjs`'s `probeRoundTrip` already encodes for `-L` channels, learned a
second time on the host side. `host-tunnel.sh` checks the SERVICE (`devtunnel show <id> --json` ->
`hostConnections`), not the process table, and additionally reaps stray host processes, supports a
pushed host-token file (`~/.garrison/host-token`, the credential `host-credential.mjs` mints and
delivers), and rate-limits its "your login expired" message instead of spinning forever.

**Correction made**: removed the new `devtunnel-host-supervisor.sh` from the repo (`git rm`) rather
than ship a strictly weaker duplicate. `host-tunnel.sh` is GENERIC (`<tunnel-id>` is its first
argument) - it already works unmodified for `swift-book-df6tw47.eun1`, not just the legacy
`peaceful-ocean` tunnel it has been running for so far. This **deliberately diverges from the plan's
literal G6 text** ("delete `FIT/scripts/host-tunnel.sh`") - that instruction assumed the new tether
design would not need host-side supervision on the Garrison side at all (VS Code / the operator would
manage it passively). Tonight's live evidence disproves that assumption: `swift-book` needs the exact
same supervision `peaceful-ocean` does. `host-tunnel.sh` stays; nothing about the plan's `tether` fallback
story ("VS Code tunnel drops 2222... fallback peaceful-ocean") required deleting it in the first place.

## The swap, and a real lockout

To replace the (now superseded) simpler supervisor with `host-tunnel.sh` on csg, this ran as one SSH
command: `kill <old-supervisor-pid>` then start the new one with `--detach`. The kill drops the SSH
session immediately - expected, it rides the very tunnel being replaced - but this time the remote
shell appears to have received SIGHUP before reaching the command that starts the new host,
because **nothing was hosting the tunnel afterward** (`devtunnel show` read `hostConnections: 0`,
confirmed twice 15s apart) and SSH through it timed out during the banner exchange. Unlike the FIRST
swap earlier tonight (foreground session -> the first supervisor), which survived an identical kill
because the very next command was already backgrounded before anything else ran, this second swap put
one more step (`sleep 1`) between the kill and the detached start, and that appears to have been enough
for the SIGHUP to land first.

**Self-inflicted, and self-sealing**: reachable only through the tunnel just taken down, with no other
channel to csg, this could not be fixed remotely. Reported to the operator plainly rather than
attempting further blind remote commands, and asked them to run, on the csg machine directly:

```
DEVTUNNEL_BIN=~/.local/bin/devtunnel sh ~/.garrison/host-tunnel.sh swift-book-df6tw47.eun1 --detach
```

(`host-tunnel.sh` and `devtunnel` are already staged there from this session's earlier steps.)

## The lesson for G7/G8 and for anyone else touching this tunnel

**Never chain a kill of the current host process with anything else in the same SSH command, even
something already backgrounded.** The safe sequence needs the START to happen and be CONFIRMED (a
`devtunnel show` read from a channel that does not depend on the process about to die - i.e. from
dev-madrid, not from inside the SSH session riding the old host) before the OLD process is killed, or
accept the brief overlap of two hosts fighting for the tunnel rather than a window with zero hosts.
`host-tunnel.sh`'s own `reap_strays` exists for exactly the resulting mess (a stray host process from
an earlier run) - lean on it rather than trying to kill-then-start atomically over a connection that
cannot survive the kill.

## What is proven and what is not (as of the lockout)

Proven, live, tonight: `devtunnel connect swift-book-df6tw47.eun1` from dev-madrid forwards port 2222
correctly; SSH through it reaches the real csg (`AZR-IMvwYA5CQHr`, WSL2 kernel
`6.18.33.2-microsoft-standard-WSL2`), matching the plan's research appendix; a restart-loop supervisor
for `devtunnel host` recovers from a killed child in seconds (proven with the now-removed simpler
script; not yet re-proven with `host-tunnel.sh` specifically, though its own test suite already covers
the property that mattered). NOT proven yet: `host-tunnel.sh` actually running stably against
`swift-book` over time, `TetherManager` against a REAL tether (only fake-`ssh`/fake-`exec` unit tests
so far - see `tests/remote-shell-tether.test.ts`), and anything requiring csg reachability from here on
(G7 install, G8 verification) until the operator brings the host back up.
