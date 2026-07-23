#!/bin/zsh
# garrison-restart-watch — out-of-tree prod restarter.
#
# WHY THIS EXISTS: "faz commit" in the web channel runs the promote INSIDE the
# operative, which is a descendant of the com.garrison.jarvis service tree.
# Restarting that service from within its own tree is unreliable: launchctl
# kickstart from that context silently no-ops (observed 2026-07-23 — commit
# c0bb4e3 pushed but prod kept serving the previous build). This watcher runs as
# its OWN LaunchAgent (com.garrison.restart-watch), NOT in the jarvis tree; when
# it kickstarts jarvis it survives, so the restart actually happens.
#
# Contract: garrison-redeploy.sh writes $REQ with the target short-commit on
# line 1. The watcher: kickstarts jarvis -> waits for the app to serve that
# commit -> waits for the operative to be running (the fresh wrapper's waiter
# does the up) -> republishes tailnet views -> clears $REQ. Idempotent.
emulate -L zsh
[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"

UID_NUM="$(id -u)"
LABEL="com.garrison.jarvis"
HOME_DIR="${GARRISON_HOME:-$HOME/.garrison}"
PROD_TREE="${GARRISON_PROD_TREE:-$HOME/dev/agent-garrison}"
REQ="$HOME_DIR/.restart-requested"
LOG="$HOME_DIR/logs/restart-watch.log"
APP_PORT="${GARRISON_APP_PORT:-8777}"
BASE="http://127.0.0.1:${APP_PORT}"
mkdir -p "$HOME_DIR/logs"

say() { print -r -- "$(date -u +%FT%TZ) $*" >> "$LOG"; }

served_commit() {
  # cut the quoted value — a sed strip of non-hex would KEEP the hex letters in
  # "data-commit=" (d,a,c) and prepend "daac" to the real hash (bug, 2026-07-23).
  curl -s --max-time 6 "$BASE/" 2>/dev/null \
    | grep -o 'data-commit="[a-f0-9]*"' | head -1 | cut -d'"' -f2
}
op_running() {
  curl -s --max-time 5 "$BASE/api/runner/jarvis/state" 2>/dev/null \
    | grep -q '"status":"running"'
}

say "restart-watch up (label=$LABEL port=$APP_PORT tree=$PROD_TREE)"

while true; do
  if [ -f "$REQ" ]; then
    target="$(head -1 "$REQ" | tr -d '[:space:]')"
    say "request seen target=${target:-<none>}"
    # Consume up front so a restart that kills something mid-flight is not
    # replayed forever; success is proven by the served-commit poll below.
    rm -f "$REQ"

    # Clear a stale redeploy lock so the fresh wrapper waiter runs the up().
    rm -f "$HOME_DIR/.redeploy-in-progress" 2>/dev/null

    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
    say "kickstart rc=$?"

    ok=""
    for i in $(seq 1 40); do
      sleep 3
      sc="$(served_commit)"
      if [ -n "$target" ]; then
        [ "$sc" = "$target" ] && { ok=1; say "served $sc == target after ~$((i*3))s"; break; }
      else
        [ -n "$sc" ] && { ok=1; say "app answering ($sc) after ~$((i*3))s"; break; }
      fi
    done

    if [ -z "$ok" ]; then
      sc="$(served_commit)"
      say "WARN restart did not reach target (serving=${sc:-none} target=${target:-none}) — killing app pid as fallback"
      pid="$(lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
      [ -n "$pid" ] && { kill "$pid" 2>/dev/null; say "killed $pid (KeepAlive respawns)"; }
      sleep 15
    fi

    # The fresh wrapper's waiter runs the up(); give it a chance, then confirm.
    for _ in $(seq 1 40); do op_running && break; sleep 3; done
    op_running && say "operative running" || say "WARN operative not running after wait"

    # Republish tailnet views (idempotent; existing mappings kept). A fitting on
    # a brand-new own port would otherwise have no HTTPS mapping.
    if [ -f "$PROD_TREE/scripts/tailnet-serve-views.mjs" ]; then
      GARRISON_INSTANCE_ID=prod GARRISON_HOME="$HOME_DIR" \
        node "$PROD_TREE/scripts/tailnet-serve-views.mjs" >>"$LOG" 2>&1 \
        || say "tailnet publish returned non-zero"
    fi
    say "restart cycle done (target=${target:-none})"
  fi
  sleep 3
done
