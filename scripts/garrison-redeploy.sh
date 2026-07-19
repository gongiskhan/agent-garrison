#!/usr/bin/env bash
# Redeploy PROD — the one sanctioned way to land committed code on the
# always-on tailnet address.
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
# Usage: scripts/garrison-redeploy.sh [composition-id]
#        composition-id defaults to the prod instance's active composition.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROD_PORT="$(bash scripts/garrison-instance.sh prod env | sed -n 's/^GARRISON_APP_PORT=//p')"
PROD_HOME="$(bash scripts/garrison-instance.sh prod env | sed -n 's/^GARRISON_HOME=//p')"
BASE="http://127.0.0.1:${PROD_PORT}"
UNIT="garrison-prod.service"

composition="${1:-}"
if [ -z "$composition" ]; then
  composition="$(node -e '
    const fs=require("fs");
    const p=process.argv[1]+"/config.json";
    try { process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).active_composition || "default"); }
    catch { process.stdout.write("default"); }
  ' "$PROD_HOME")"
fi

say() { printf "\n[redeploy] %s\n" "$*"; }

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
if systemctl --user list-unit-files "$UNIT" >/dev/null 2>&1 \
   && systemctl --user cat "$UNIT" >/dev/null 2>&1; then
  say "restarting $UNIT"
  systemctl --user restart "$UNIT"
else
  echo "[redeploy] $UNIT not installed — start prod manually:" >&2
  echo "           bash scripts/garrison-instance.sh prod start" >&2
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
  systemctl --user status "$UNIT" --no-pager -n 30 >&2 || true
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
