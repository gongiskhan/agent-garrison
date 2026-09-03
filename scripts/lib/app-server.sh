#!/usr/bin/env bash
# Shared by garrison-redeploy.sh and garrison-reload.sh: make sure the app
# server we are replacing is really gone once the supervisor has restarted it.
#
# `next start` answers SIGTERM by closing its listener and then waiting for
# every open connection to finish. Fittings keep keep-alive and SSE connections
# into the shell, so that wait never ends: the old next-server outlives its
# supervisor as an orphan, keeps serving stale keep-alive clients on the OLD
# code, keeps every fitting it spawned as its child (so they never pick up new
# code either), and its handlers keep opening requests into the new server
# until that one is starved. Seen on the Mac 2026-09-03: 128 hung connections,
# the new shell silent for an hour, "prod did not come up".
#
# Usage, around the supervisor restart:
#   old_pid="$(app_server_pid_on_port "$PORT")"
#   ... restart ...
#   ensure_old_app_server_gone "$old_pid"

app_server_pid_on_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

wait_for_exit() {
  local pid="$1" i
  for i in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

# A supervised app server has the launcher's `concurrently` as its parent, so a
# next-server whose parent is the init/launchd/systemd reaper (or gone) is an
# orphan by definition. `next dev` children are parented to their `next dev`
# process and are left alone.
reap_orphan_app_servers() {
  local pid ppid pcmd
  while read -r pid ppid; do
    [ -n "$pid" ] || continue
    pcmd="$(ps -o command= -p "$ppid" 2>/dev/null || true)"
    if [ "$ppid" != "1" ] && [ -n "$pcmd" ]; then
      case "$pcmd" in
        *launchd*|*systemd*) ;;
        *) continue ;;
      esac
    fi
    echo "[app-server] ending orphaned next-server $pid (parent $ppid: ${pcmd:-gone})"
    kill -KILL "$pid" 2>/dev/null || true
  done < <(ps -Ao pid=,ppid=,command= | awk '$3 == "next-server" { print $1, $2 }')
}

ensure_old_app_server_gone() {
  local old_pid="$1"
  if [ -n "$old_pid" ] && ! wait_for_exit "$old_pid"; then
    echo "[app-server] old app server $old_pid still alive after the restart; ending it"
    kill -KILL "$old_pid" 2>/dev/null || true
  fi
  reap_orphan_app_servers
}
