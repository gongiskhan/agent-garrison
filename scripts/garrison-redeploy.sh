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
    // 1. explicit config, 2. the composition prod last ran, 3. jarvis.
    try { const c = read(home + "/config.json").active_composition; if (c) { process.stdout.write(c); process.exit(0); } } catch {}
    try {
      const keys = Object.keys(read(home + "/coord-lifecycle.json"));
      if (keys.length === 1) { process.stdout.write(keys[0]); process.exit(0); }
    } catch {}
    process.stdout.write("jarvis");
  ' "$PROD_HOME")"
fi

say() { printf "\n[redeploy] %s\n" "$*"; }
say "composition=$composition  port=$PROD_PORT  home=$PROD_HOME"

# --- 1. build ---------------------------------------------------------------
say "building prod bundle (.next-prod)"
bash scripts/garrison-instance.sh prod build

# --- 2. stop the operative on the old code ----------------------------------
# Best-effort: a prod server that is down (or a composition that was never up)
# must not abort the redeploy — the up() at step 4 is what has to succeed.
if curl -sf -o /dev/null --max-time 5 "$BASE/api/compositions"; then
  say "stopping operative + fittings ($composition)"
  curl -sf -X POST --max-time 120 "$BASE/api/runner/$composition/down" >/dev/null \
    || echo "[redeploy] down returned non-zero (continuing)"
else
  say "prod app not responding on $BASE — skipping pre-down"
fi

# --- 3. swap the app server -------------------------------------------------
: > "$REDEPLOY_LOCK"
restarted=""
if command -v launchctl >/dev/null 2>&1 \
   && launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  say "restarting launchd agent $LAUNCHD_LABEL"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
  restarted=launchd
elif command -v systemctl >/dev/null 2>&1 \
     && systemctl --user cat "$UNIT" >/dev/null 2>&1; then
  say "restarting $UNIT"
  systemctl --user restart "$UNIT"
  restarted=systemd
fi

if [ -z "$restarted" ]; then
  echo "[redeploy] no supervisor found for prod." >&2
  echo "           launchd: expected LaunchAgent $LAUNCHD_LABEL" >&2
  echo "           systemd: expected user unit $UNIT" >&2
  echo "           or start prod by hand: bash scripts/garrison-instance.sh prod start" >&2
  exit 1
fi

# --- wait for the new server ------------------------------------------------
say "waiting for $BASE"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 3 "$BASE/api/compositions"; then
    break
  fi
  sleep 2
done
if ! curl -sf -o /dev/null --max-time 3 "$BASE/api/compositions"; then
  echo "[redeploy] prod did not come up on $BASE" >&2
  if [ "$restarted" = launchd ]; then
    tail -n 30 "$PROD_HOME/logs/launchd-garrison.err.log" >&2 || true
  else
    systemctl --user status "$UNIT" --no-pager -n 30 >&2 || true
  fi
  exit 1
fi

# --- 4. bring the operative + eager fittings back on the new code -----------
say "starting operative + eager fittings ($composition)"
curl -sf -X POST --max-time 600 "$BASE/api/runner/$composition/up" >/dev/null

# --- 5. publish any newly-started own-port view to the tailnet --------------
# Idempotent (existing mappings are kept). Without this a fitting that gains an
# own port, or one started for the first time, has no `tailscale serve` mapping
# and its embedded view is a BLANK pane over the tailnet: the iframe would need
# a plain-HTTP frame on an HTTPS page, which the browser blocks as mixed
# content. Exactly how drill's view broke.
say "publishing own-port views to the tailnet"
# Pass prod's identity explicitly: the script reads $GARRISON_HOME/ui-fittings to
# find running views, and its own guard refuses any non-prod profile. Relying on
# the ~/.garrison default would happen to work but would silently publish the
# wrong instance's views if the default ever changed.
GARRISON_INSTANCE_ID=prod GARRISON_HOME="$PROD_HOME" \
  node "$REPO_ROOT/scripts/tailnet-serve-views.mjs" || \
  echo "[redeploy] tailnet publish failed (views may be unreachable off-box)"

say "done — prod serving $BASE (tailnet: https://dev-madrid.tail31efa.ts.net)"
