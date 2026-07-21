#!/usr/bin/env bash
# Control the DEV instance without a terminal session holding it open.
#
# Dev runs under its own LaunchAgent (`com.garrison.dev`, RunAtLoad=false,
# KeepAlive=false) so it can be started, stopped and restarted by a single
# command — from the operative, from a Fitting, from anywhere — and it keeps
# running after the caller exits. Prod's agent (`com.garrison.jarvis`) is a
# separate unit and is never touched by this script.
#
# Dev is ON-DEMAND, not always-on: this box has 8 GB of RAM and prod already
# holds a Next server, the outpost, the scheduler, four own-port Fittings and a
# live Claude Code operative. A second `next dev` compiling in the background
# would starve it. Start dev to test, stop it when done.
#
# `start` brings up the dev SERVER only. Bringing the dev operative up is a
# separate, explicit step (`up`) — booting a second Jarvis automatically would
# put two voice agents on the same microphone.
#
# Usage: scripts/garrison-dev.sh {start|stop|restart|status|up|down|logs|url}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The LaunchAgent points at the dev TREE, so this script must report on that
# tree no matter which checkout it was invoked from — running the prod copy of
# this script still controls (and describes) dev.
DEV_TREE="${GARRISON_DEV_TREE:-$HOME/dev/agent-garrison-dev}"

LABEL="com.garrison.dev"
TARGET="gui/$(id -u)/$LABEL"

DEV_ENV="$(bash "$SCRIPT_DIR/garrison-instance.sh" dev env)"
DEV_PORT="$(printf '%s\n' "$DEV_ENV" | sed -n 's/^GARRISON_APP_PORT=//p')"
DEV_HOME="$(printf '%s\n' "$DEV_ENV" | sed -n 's/^GARRISON_HOME=//p')"
BASE="http://127.0.0.1:${DEV_PORT}"
LOG="$DEV_HOME/logs/launchd-dev.out.log"
ERRLOG="$DEV_HOME/logs/launchd-dev.err.log"

composition="${GARRISON_COMPOSITION:-jarvis}"

say() { printf "[dev] %s\n" "$*"; }

alive() { curl -sf -o /dev/null --max-time 3 "$BASE/api/compositions"; }

wait_for_up() {
  # `next dev` compiles the first route on demand, so a cold start answers
  # noticeably later than prod's prebuilt server. 120s is the observed ceiling.
  for _ in $(seq 1 60); do
    alive && return 0
    sleep 2
  done
  return 1
}

case "${1:-status}" in
  start)
    if alive; then say "already up on $BASE"; exit 0; fi
    launchctl print "$TARGET" >/dev/null 2>&1 \
      || { echo "[dev] LaunchAgent $LABEL is not loaded — run scripts/garrison-dev-install.sh" >&2; exit 1; }
    say "starting dev server"
    launchctl kickstart "$TARGET"
    if wait_for_up; then
      say "up on $BASE"
    else
      echo "[dev] did not come up on $BASE — last 30 lines of $ERRLOG:" >&2
      tail -n 30 "$ERRLOG" >&2 || true
      exit 1
    fi
    ;;
  stop)
    say "stopping dev operative + fittings (best-effort)"
    alive && curl -sf -X POST --max-time 120 "$BASE/api/runner/$composition/down" >/dev/null 2>&1 || true
    say "stopping dev server"
    launchctl kill TERM "$TARGET" 2>/dev/null || true
    say "stopped"
    ;;
  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;
  up)
    alive || { echo "[dev] server is not running — scripts/garrison-dev.sh start" >&2; exit 1; }
    say "bringing up operative + eager fittings ($composition)"
    curl -sf -X POST --max-time 600 "$BASE/api/runner/$composition/up" >/dev/null
    say "up"
    ;;
  down)
    alive || { echo "[dev] server is not running" >&2; exit 1; }
    say "stopping operative + fittings ($composition)"
    curl -sf -X POST --max-time 120 "$BASE/api/runner/$composition/down" >/dev/null
    say "down"
    ;;
  status)
    if alive; then
      say "server: UP    $BASE"
    else
      say "server: down  ($BASE)"
    fi
    say "home:   $DEV_HOME"
    say "tree:   $DEV_TREE"
    say "branch: $(git -C "$DEV_TREE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') @ $(git -C "$DEV_TREE" rev-parse --short HEAD 2>/dev/null || echo '?')"
    say "uncommitted: $(git -C "$DEV_TREE" status --porcelain 2>/dev/null | wc -l | tr -d ' ') file(s)"
    ;;
  logs)
    tail -n "${2:-60}" -F "$LOG" "$ERRLOG"
    ;;
  url)
    printf '%s\n' "$BASE"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|up|down|logs|url}" >&2
    exit 2
    ;;
esac
