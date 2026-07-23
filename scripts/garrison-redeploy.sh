#!/usr/bin/env bash
# Redeploy PROD — the one sanctioned way to land committed code on the
# always-on address.
#
# HARD RULE (CLAUDE.md): a commit is not landed until prod has been redeployed.
# Prod serves a BUILT artifact, so committing alone changes nothing a user can
# see; and the operative + own-port fittings are long-lived processes holding
# the OLD code in memory. Restarting the Next server without restarting them
# leaves a half-updated system that is worse than not deploying at all.
#
# Order matters:
#   1. build     — fail here and prod keeps serving the last good build
#   2. down      — stop the operative and its fittings on the OLD code
#   3. restart   — swap the app server onto the new build
#   4. up        — operative + eager fittings come back on the NEW code
#
# Supervisor: this host runs prod under **launchd**, not systemd. The unit is
# the LaunchAgent `com.garrison.jarvis` (RunAtLoad + KeepAlive), whose wrapper
# is ~/.local/bin/garrison-launch.sh. `launchctl kickstart -k` stops and
# respawns it in one call. The systemd path is kept for Linux hosts.
#
# Usage: scripts/garrison-redeploy.sh [composition-id]
#        composition-id defaults to the prod instance's active composition.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROD_ENV="$(bash scripts/garrison-instance.sh prod env)"
PROD_PORT="$(printf '%s\n' "$PROD_ENV" | sed -n 's/^GARRISON_APP_PORT=//p')"
PROD_HOME="$(printf '%s\n' "$PROD_ENV" | sed -n 's/^GARRISON_HOME=//p')"
BASE="http://127.0.0.1:${PROD_PORT}"

UNIT="garrison-prod.service"          # systemd (Linux hosts)
LAUNCHD_LABEL="com.garrison.jarvis"   # launchd (this Mac)

# The launch wrapper spawns a waiter that POSTs /up once the app answers. During
# a redeploy THIS script owns the `up`, so the marker tells that waiter to stand
# down — otherwise two concurrent up() calls race over the same operative.
REDEPLOY_LOCK="$PROD_HOME/.redeploy-in-progress"
mkdir -p "$PROD_HOME"
cleanup() { rm -f "$REDEPLOY_LOCK"; }
trap cleanup EXIT

composition="${1:-${GARRISON_COMPOSITION:-}}"
if [ -z "$composition" ]; then
  composition="$(node -e '
    const fs = require("fs");
    const home = process.argv[1];
    const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
    // 1. the composition prod last actually RAN (coord-lifecycle), 2. the
    //    active_composition pointer, 3. jarvis.
    // The lifecycle file leads because the pointer has been observed drifting
    // back to "default" (2026-07-21, writer unidentified) — and redeploying
    // that composition then silently swaps the always-on operative.
    // What prod was running is the ground truth for what to bring back.
    try {
      const keys = Object.keys(read(home + "/coord-lifecycle.json"));
      if (keys.length === 1) { process.stdout.write(keys[0]); process.exit(0); }
    } catch {}
    try { const c = read(home + "/config.json").active_composition; if (c) { process.stdout.write(c); process.exit(0); } } catch {}
    process.stdout.write("jarvis");
  ' "$PROD_HOME")"
fi

say() { printf "\n[redeploy] %s\n" "$*"; }
say "composition=$composition  port=$PROD_PORT  home=$PROD_HOME"

# --- 1. build ---------------------------------------------------------------
say "building prod bundle (.next-prod)"
bash scripts/garrison-instance.sh prod build
# A build that exits 0 can still be unservable: on this 8 GB box an OOM-killed
# child once left .next-prod without prerender-manifest.json and next start
# crash-looped under KeepAlive while the OLD process kept serving (2026-07-23).
# Refuse to touch the running prod until the artifact is provably complete.
for f in BUILD_ID prerender-manifest.json routes-manifest.json; do
  if [ ! -f "$REPO_ROOT/.next-prod/$f" ]; then
    echo "[redeploy] build incomplete: .next-prod/$f missing — aborting before down" >&2
    exit 1
  fi
done

# --- 2. stop the operative on the old code ----------------------------------
# Best-effort: a prod server that is down (or a composition that was never up)
# must not abort the redeploy — the up() at step 4 is what has to succeed.
# No graceful pre-down: the restart below is a hard service kill, and calling
# /down here would — when this promote runs INSIDE the operative (chat "faz
# commit") — stop the very operative running it, killing the promote before it
# can even request the restart. The hard restart stops everything cleanly.
say "skipping graceful pre-down (hard restart handles it)"

# --- 3. request an OUT-OF-TREE restart -------------------------------------
# "faz commit" in the web channel runs this promote INSIDE the operative, a
# descendant of the com.garrison.jarvis tree. Restarting a service from within
# its own tree is unreliable: launchctl kickstart silently no-ops from that
# context and a kill takes the promote down with it (seen 2026-07-23 — c0bb4e3
# pushed but prod kept serving the old build). So we hand the restart to
# com.garrison.restart-watch, a separate always-on LaunchAgent NOT in this tree.
# It kickstarts jarvis; the fresh wrapper's waiter runs the up(); the watcher
# republishes tailnet. We do NOT hold $REDEPLOY_LOCK — this script is very
# likely dead (killed by the restart it asked for) before the up() would run, so
# the fresh waiter MUST be free to do it.
rm -f "$REDEPLOY_LOCK" 2>/dev/null || true
head_short="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
say "requesting out-of-tree restart -> $head_short (com.garrison.restart-watch)"
printf '%s\n' "$head_short" > "$PROD_HOME/.restart-requested"

# Wait for prod to actually SERVE the new commit. data-commit is rendered per
# request from the prod tree HEAD, so this proves the app swapped builds.
served=""
for i in $(seq 1 70); do
  sleep 3
  served="$(curl -s --max-time 5 "$BASE/" 2>/dev/null | grep -o 'data-commit="[a-f0-9]*"' | head -1 | cut -d'"' -f2)"
  [ "$served" = "$head_short" ] && break
  # ~36s in with the request still unconsumed -> no watcher running. Fall back to
  # an in-line kickstart (works when THIS process is out-of-tree, e.g. an ssh
  # promote; a harmless no-op if in-tree).
  if [ "$i" = "12" ] && [ -f "$PROD_HOME/.restart-requested" ]; then
    say "restart-watch has not consumed the request — in-line kickstart fallback"
    if command -v launchctl >/dev/null 2>&1 \
       && launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
    elif command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$UNIT" >/dev/null 2>&1; then
      systemctl --user restart "$UNIT" 2>/dev/null || true
    fi
  fi
done

if [ "$served" != "$head_short" ]; then
  echo "[redeploy] prod is serving '${served:-none}' but HEAD is $head_short — restart did not take" >&2
  tail -n 25 "$PROD_HOME/logs/restart-watch.log" 2>/dev/null >&2 || true
  exit 1
fi
say "done — prod serving $BASE at commit $head_short (restart via watch agent)"
