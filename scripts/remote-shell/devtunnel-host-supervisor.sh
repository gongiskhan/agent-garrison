#!/bin/sh
# devtunnel-host-supervisor.sh <tunnel-id> [log-dir]
#
# `devtunnel host <id>` has no daemon mode and no built-in restart. Left in a
# foreground terminal it dies with that terminal (SIGHUP); left alone it can
# also die on its own - observed live on csg (2026-09-03): the relay drops
# and reconnects repeatedly (self-healing, the CLI handles that on its own -
# "Connection to host tunnel relay closed... Reconnecting... restored." is
# normal noise, not a failure), but occasionally the refreshed access token
# comes back invalid ("Error connecting host tunnel session: Not authorized
# ... Refreshed tunnel access token is not valid") and the process needs a
# human to kill and re-run it, sometimes preceded by a "Warning: Approaching
# limit for 'BandwidthPerUser'" note. This wraps the command in a restart
# loop with backoff, so a token-refresh failure or a bandwidth-driven
# disconnect self-heals in seconds instead of silently staying dark until
# someone notices the tunnel is gone.
#
# `setsid` detaches the child from THIS script's controlling terminal (if
# any), so closing the terminal that launched the supervisor does not take
# the tunnel down with it - the whole point. Run this itself under `nohup ...
# &`, a tmux/screen session, or (once the node is installed) node-supervisor.sh.
#
# State: <log-dir>/<tunnel-id>.log (capped, rotates itself), .state (one JSON
# line, current status), .supervisor.pid, .child.pid.

set -u

TUNNEL_ID="${1:?usage: devtunnel-host-supervisor.sh <tunnel-id> [log-dir]}"
LOG_DIR="${2:-$HOME/.garrison/devtunnel-host}"
BIN="${DEVTUNNEL_BIN:-devtunnel}"
MAX_LOG_BYTES=2000000
BASE_BACKOFF=2
MAX_BACKOFF=60
STABLE_AFTER_SEC=60

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$TUNNEL_ID.log"
STATE_FILE="$LOG_DIR/$TUNNEL_ID.state"
SUP_PID_FILE="$LOG_DIR/$TUNNEL_ID.supervisor.pid"
CHILD_PID_FILE="$LOG_DIR/$TUNNEL_ID.child.pid"

echo "$$" > "$SUP_PID_FILE"

child_pid=""
cleanup() {
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[supervisor] $ts stopping on signal" >> "$LOG_FILE"
  if [ -n "$child_pid" ]; then
    kill "$child_pid" 2>/dev/null
  fi
  printf '{"state":"stopped","at":"%s"}\n' "$ts" > "$STATE_FILE"
  exit 0
}
trap cleanup INT TERM

rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ]; then
    tail -c 500000 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

backoff="$BASE_BACKOFF"
restarts=0

while true; do
  rotate_log
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  started_at=$(date +%s)
  echo "[supervisor] $ts starting: $BIN host $TUNNEL_ID (attempt $((restarts + 1)))" >> "$LOG_FILE"
  printf '{"state":"starting","at":"%s","restarts":%d}\n' "$ts" "$restarts" > "$STATE_FILE"

  setsid "$BIN" host "$TUNNEL_ID" >> "$LOG_FILE" 2>&1 &
  child_pid=$!
  echo "$child_pid" > "$CHILD_PID_FILE"
  wait "$child_pid"
  code=$?
  child_pid=""
  ended_at=$(date +%s)
  ran_for=$((ended_at - started_at))

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[supervisor] $ts exited after ${ran_for}s (code $code)" >> "$LOG_FILE"
  restarts=$((restarts + 1))
  printf '{"state":"restarting","at":"%s","restarts":%d,"lastExitCode":%d,"ranForSec":%d}\n' \
    "$ts" "$restarts" "$code" "$ran_for" > "$STATE_FILE"

  # Not fatal by itself, but worth surfacing without scanning raw C# stack
  # traces: a bandwidth warning in the last stretch of output usually
  # precedes the next disconnect.
  if tail -n 200 "$LOG_FILE" | grep -q "Approaching limit for 'BandwidthPerUser'"; then
    echo "[supervisor] $ts note: recent output shows a BandwidthPerUser warning - approaching the relay's per-user quota, expect more disconnects" >> "$LOG_FILE"
  fi

  if [ "$ran_for" -ge "$STABLE_AFTER_SEC" ]; then
    backoff="$BASE_BACKOFF"
  else
    backoff=$((backoff * 2))
    [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff="$MAX_BACKOFF"
  fi
  sleep "$backoff"
done
