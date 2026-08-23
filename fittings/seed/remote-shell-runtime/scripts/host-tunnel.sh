#!/bin/sh
# Host the Garrison ssh tunnel FROM the remote machine. Runs THERE, not here.
#
# WHY A SCRIPT AND NOT A COMMAND. `devtunnel host` is a foreground process, so it
# dies with the shell that started it - and when it dies, Garrison's only route
# into the machine is gone with no signal on this side beyond "the forward did
# not come up". The remote is typically a WSL box with no systemd to lean on, so
# the keepalive has to be this: a loop, detached from the terminal, with backoff
# so a service outage does not become a spin.
#
# DIRECTION. This still dials OUT to Microsoft's relay; it opens no listener and
# never contacts Garrison. The inbound-only invariant holds - Garrison connects
# to the same relay from its side.
#
# Usage, on the remote:
#   sh host-tunnel.sh <tunnel-id>            # run in the foreground (to watch it)
#   sh host-tunnel.sh <tunnel-id> --detach   # survive the terminal closing
#
# Check it took: `devtunnel show <tunnel-id>` should report 1 host connection.

set -eu

TUNNEL="${1:-}"
[ -n "$TUNNEL" ] || { echo "usage: sh host-tunnel.sh <tunnel-id> [--detach]" >&2; exit 2; }
DEVTUNNEL="${DEVTUNNEL_BIN:-devtunnel}"
LOG="${HOST_TUNNEL_LOG:-$HOME/.garrison/host-tunnel.log}"
mkdir -p "$(dirname "$LOG")"

if [ "${2:-}" = "--detach" ]; then
  # setsid where available (Linux/WSL); nohup alone elsewhere. Re-exec without
  # the flag so the child runs the loop below.
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$0" "$TUNNEL" >>"$LOG" 2>&1 &
  else
    nohup "$0" "$TUNNEL" >>"$LOG" 2>&1 &
  fi
  echo "hosting $TUNNEL in the background; log: $LOG"
  exit 0
fi

# Fail loudly on the one prerequisite, rather than looping on it forever.
if ! "$DEVTUNNEL" user show 2>&1 | grep -qi "logged in"; then
  echo "not logged in: run \`$DEVTUNNEL user login\` on this machine first" >&2
  exit 3
fi

backoff=2
while :; do
  echo "[$(date -u +%FT%TZ)] hosting $TUNNEL"
  # Exits 0 only when asked to stop; any other exit is a drop worth retrying.
  if "$DEVTUNNEL" host "$TUNNEL"; then
    echo "[$(date -u +%FT%TZ)] host exited cleanly"
    exit 0
  fi
  echo "[$(date -u +%FT%TZ)] host dropped; retrying in ${backoff}s"
  sleep "$backoff"
  # Cap the backoff: a relay outage should not push the retry into next week.
  backoff=$((backoff * 2))
  [ "$backoff" -le 60 ] || backoff=60
done
