#!/bin/sh
# Host the Garrison ssh tunnel FROM the remote machine. Runs THERE, not here.
#
# WHY A SUPERVISOR AND NOT A RESTART LOOP. `devtunnel host` is a foreground
# process, so it dies with the shell that started it - but the failure that
# actually took the tunnel down for a day was the opposite. When the relay drops
# a host ("Connection to host tunnel relay closed. Another host for the tunnel
# has connected.") the process does NOT exit: it stays alive, hosting nothing.
# A loop keyed on process exit can never fire, so `ps` shows a healthy
# supervisor while `devtunnel show` reports zero hosts. Liveness is not health.
#
# So health is asked of the SERVICE - hostConnections on the tunnel - and the
# child is replaced when that reads zero, whatever the process table says. Two
# consecutive misses, so one unlucky query does not bounce a working tunnel.
#
# DIRECTION. This dials OUT to Microsoft's relay; it opens no listener and never
# contacts Garrison. The inbound-only invariant holds - Garrison connects to the
# same relay from its side.
#
# CREDENTIAL. Two ways to authenticate, in this order:
#
#   1. A HOST TOKEN at $HOME/.garrison/host-token (override: HOST_TUNNEL_TOKEN_FILE).
#      Garrison mints one on its side and pushes it over the live tunnel, hourly;
#      the token lasts 24h, so there is a full day of slack before a lapse. This
#      machine then never needs an interactive `devtunnel user login` - which
#      matters because it is reachable ONLY through the tunnel this script holds
#      up, so a credential that needs a human here is a credential that cannot be
#      renewed when it is needed most.
#   2. Otherwise the machine's own devtunnel login, as before.
#
# The token is re-read from disk on every (re)start, so a freshly pushed one is
# picked up by the next cycle with nothing to restart. It is passed on stdin
# (`-t -`), never in argv, so it stays out of `ps` for every other user on the box.
#
# Usage, on the remote:
#   sh host-tunnel.sh <tunnel-id>            # foreground, to watch it
#   sh host-tunnel.sh <tunnel-id> --detach   # survive the terminal closing
#
# Check it took, from anywhere logged in:
#   devtunnel show <tunnel-id> --json    # hostConnections must be >= 1

set -eu

TUNNEL="${1:-}"
[ -n "$TUNNEL" ] || { echo "usage: sh host-tunnel.sh <tunnel-id> [--detach]" >&2; exit 2; }
DEVTUNNEL="${DEVTUNNEL_BIN:-devtunnel}"
LOG="${HOST_TUNNEL_LOG:-$HOME/.garrison/host-tunnel.log}"
INTERVAL="${HOST_TUNNEL_INTERVAL:-20}"
TOKEN_FILE="${HOST_TUNNEL_TOKEN_FILE:-$HOME/.garrison/host-token}"
mkdir -p "$(dirname "$LOG")"

if [ "${2:-}" = "--detach" ]; then
  # setsid where available (Linux/WSL); nohup alone elsewhere. Re-exec without
  # the flag so the child runs the supervisor below.
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$0" "$TUNNEL" >>"$LOG" 2>&1 &
  else
    nohup "$0" "$TUNNEL" >>"$LOG" 2>&1 &
  fi
  echo "hosting $TUNNEL in the background; log: $LOG"
  exit 0
fi

say() { echo "[$(date -u +%FT%TZ)] $*"; }

# The credential is the one thing this script cannot repair. A devtunnel GitHub
# login lasts well under a day, so it WILL lapse under a long-running supervisor
# - and when it does, `devtunnel host` cannot authenticate while still refusing
# to exit, so a supervisor that only checked at startup would replace a child
# that can never work, forever, silently. Checked here and again before every
# replacement.
have_token() { [ -s "$TOKEN_FILE" ]; }
logged_in() { have_token || "$DEVTUNNEL" user show 2>&1 | grep -qi "logged in"; }

# Every devtunnel call goes through here so the token path and the login path
# differ in exactly one place.
dt() {
  if have_token; then
    "$DEVTUNNEL" "$@" -t - < "$TOKEN_FILE"
  else
    "$DEVTUNNEL" "$@"
  fi
}

if ! logged_in; then
  say "no credential: put a host token at $TOKEN_FILE, or run \`$DEVTUNNEL user login -g -d\` on this machine" >&2
  exit 3
fi
have_token && say "using host token from $TOKEN_FILE" || say "using this machine's devtunnel login"

CHILD=""

# Kicked-but-alive hosts from earlier runs hold nothing and fix nothing; left
# behind they make the process table lie about the tunnel's state.
reap_strays() {
  command -v pgrep >/dev/null 2>&1 || return 0
  for pid in $(pgrep -f "devtunnel host $TUNNEL" 2>/dev/null || true); do
    [ "$pid" = "$CHILD" ] && continue
    [ "$pid" = "$$" ] && continue
    say "reaping stray host process $pid"
    kill "$pid" 2>/dev/null || true
  done
}

start_host() {
  # `( exec ... ) &` so the background pid IS devtunnel. Backgrounding a shell
  # FUNCTION instead would make $CHILD a wrapper subshell, and killing that would
  # leave the real host process orphaned - alive, still holding the tunnel, and
  # invisible to every check here. The token file is re-read on each start, so one
  # pushed since the last cycle is picked up with nothing to restart.
  if have_token; then
    ( exec "$DEVTUNNEL" host "$TUNNEL" -t - < "$TOKEN_FILE" ) &
  else
    ( exec "$DEVTUNNEL" host "$TUNNEL" ) &
  fi
  CHILD=$!
  say "started devtunnel host (pid $CHILD)"
}

stop_child() {
  [ -n "$CHILD" ] || return 0
  kill "$CHILD" 2>/dev/null || true
  sleep 2
  kill -9 "$CHILD" 2>/dev/null || true
}

# Ask the service, not the process table. Absent/0 means nobody is hosting -
# including us, whatever our child thinks it is doing.
#
# What this does NOT catch: another machine hosting the same tunnel. Then the
# count reads 1 while our child is the one that got kicked, and the forward
# points at the wrong box. Nothing else legitimately hosts this tunnel, and the
# outage actually seen was a count of 0, so this stays a known gap rather than
# guesswork about which host the service picked.
hosted() {
  dt show "$TUNNEL" --json 2>/dev/null | grep -q '"hostConnections"[: ]*[1-9]'
}

trap 'stop_child; exit 0' INT TERM

reap_strays
start_host
misses=0
expired_said=0

while :; do
  sleep "$INTERVAL"
  if ! kill -0 "$CHILD" 2>/dev/null; then
    say "host process exited; restarting"
    start_host
    misses=0
    continue
  fi
  if hosted; then
    misses=0
    continue
  fi
  misses=$((misses + 1))
  # One miss can be a transient read against the service; two is a dead host.
  [ "$misses" -ge 2 ] || continue
  if ! logged_in; then
    # Replacing the child would achieve nothing: the new one cannot authenticate
    # either. Say so once per lapse, at a slow cadence, and wait for a human -
    # the log is the only place this can be read from once the tunnel is down.
    if [ "$expired_said" != "1" ]; then
      if have_token; then
        say "HOST TOKEN REJECTED or expired ($TOKEN_FILE) - Garrison could not have pushed a fresh one for over a day. Not restarting the host; it could not authenticate."
      else
        say "LOGIN EXPIRED on this machine - the tunnel stays down until someone runs \`$DEVTUNNEL user login -g -d\` HERE. Not restarting the host; it could not authenticate."
      fi
      expired_said=1
    fi
    sleep 60
    continue
  fi
  expired_said=0
  say "tunnel reports no host while pid $CHILD is still alive - replacing it"
  stop_child
  reap_strays
  start_host
  misses=0
done
