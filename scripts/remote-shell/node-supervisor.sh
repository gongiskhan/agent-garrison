#!/bin/sh
# node-supervisor.sh <daemon|ensure|start|stop|restart|status|run>
#
# Keeps `scripts/garrison-instance.sh node start` (the Garrison node process -
# app, gateway, every fitting) running on a machine with no systemd-user
# (csg: WSL2, commonly with no systemd at all). The tether's `onUp` calls
# `ensure` every time the reverse+forward tunnel comes back up, so a WSL
# restart or a supervisor crash self-heals the moment connectivity returns -
# no cron, no manual step, the same self-healing shape host-tunnel.sh already
# proved for the devtunnel host side.
#
# `setsid` runs ONLY at the outer `daemon` boundary (detaching the whole
# supervisor from whatever launched it), never again inside the loop - the
# node process it starts stays in the SAME process group as the loop itself,
# which is what lets `stop` kill the whole group (loop + node + whatever node
# itself spawned) with one signal instead of hunting down orphans one at a
# time.
#
# Verbs:
#   run       foreground restart loop (what daemon backgrounds)
#   daemon    start the loop detached; a no-op if already running
#   start     alias for daemon
#   ensure    alias for daemon (named separately so tether.onUp's intent reads
#             clearly: "make sure this is running", not "start it again")
#   stop      stop the supervisor AND everything it is currently running
#   restart   stop then start
#   status    print running/stopped + pid; exits 0/1 to match

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_SUPERVISOR_HOME="${GARRISON_HOME:-$HOME/.garrison}"
PID_FILE="$NODE_SUPERVISOR_HOME/node-supervisor.pid"
LOG_FILE="$NODE_SUPERVISOR_HOME/node-supervisor.log"
# What "run the Garrison node process" means - overridable so a test can point
# this at a lightweight stand-in instead of actually booting the real node
# (which would fight the live composition-owner lock and real ports).
SUPERVISED_TARGET="${NODE_SUPERVISOR_TARGET:-$REPO_ROOT/scripts/garrison-instance.sh}"
BASE_BACKOFF="${NODE_SUPERVISOR_BACKOFF:-5}"
CLOCK_SYNC_INTERVAL=600

mkdir -p "$NODE_SUPERVISOR_HOME"

# Found live: a caller invoking `restart`/`start` without re-passing
# GARRISON_NODE_NAME (every later restart, not just the first start) fell
# through straight to the raw machine hostname - on csg that is its Azure/WSL
# hostname, not "csg", and every fitting spawned under it self-identified
# wrong for the rest of that process's life. node.json's own `id` is the
# durable identity (install-node.sh writes it once and never again) - prefer
# it over a caller-dependent env var so a restart is not the ONE call that
# has to remember to pass it.
if [ -z "${GARRISON_NODE_NAME:-}" ] && [ -s "$NODE_SUPERVISOR_HOME/node.json" ] && command -v node >/dev/null 2>&1; then
  GARRISON_NODE_NAME="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(j.id)process.stdout.write(String(j.id))}catch{}' "$NODE_SUPERVISOR_HOME/node.json" 2>/dev/null)"
fi
export GARRISON_NODE_NAME="${GARRISON_NODE_NAME:-$( (command -v hostname >/dev/null 2>&1 && hostname) || echo node)}"
export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"
export PATH="$HOME/.local/bin:$PATH"

say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"; }

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || echo)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

do_run() {
  echo $$ > "$PID_FILE"
  child_pid=""
  trap 'say "supervisor stopping on signal"; [ -n "$child_pid" ] && kill "$child_pid" 2>/dev/null; rm -f "$PID_FILE"; exit 0' INT TERM

  last_clock_sync=0
  while true; do
    started_at=$(date +%s)
    say "starting: bash $SUPERVISED_TARGET node start"
    bash "$SUPERVISED_TARGET" node start >> "$LOG_FILE" 2>&1 &
    child_pid=$!
    # `if wait; then/else` (not a bare `wait; code=$?`) because under `set -e`
    # a bare non-zero `wait` aborts do_run right here - the loop would stop
    # retrying forever after the very first crashing start, silently.
    if wait "$child_pid"; then code=0; else code=$?; fi
    child_pid=""
    ended_at=$(date +%s)
    say "exited after $((ended_at - started_at))s (code $code)"

    now=$(date +%s)
    if [ $((now - last_clock_sync)) -ge "$CLOCK_SYNC_INTERVAL" ] && command -v sudo >/dev/null 2>&1; then
      sudo -n hwclock -s >/dev/null 2>&1 || true
      last_clock_sync=$now
    fi

    sleep "$BASE_BACKOFF"
  done
}

case "${1:-}" in
  run)
    do_run
    ;;
  daemon|start|ensure)
    if pid="$(running_pid)"; then
      echo "already running (pid $pid)"
      exit 0
    fi
    # setsid so closing whatever launched this (an ssh session, a terminal)
    # never takes the supervisor down with it - the whole point.
    setsid "$0" run >/dev/null 2>&1 < /dev/null &
    disown 2>/dev/null || true
    echo "started"
    ;;
  stop)
    if pid="$(running_pid)"; then
      # Negative pid = the whole process GROUP (the loop and whatever it is
      # currently running, which shares its group - see the header note on
      # why the inner spawn deliberately does not setsid).
      kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if pid="$(running_pid)"; then
      echo "running (pid $pid)"
      exit 0
    fi
    echo "stopped"
    exit 1
    ;;
  *)
    echo "usage: node-supervisor.sh <daemon|ensure|start|stop|restart|status|run>" >&2
    exit 2
    ;;
esac
