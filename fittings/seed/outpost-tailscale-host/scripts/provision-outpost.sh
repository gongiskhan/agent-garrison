#!/usr/bin/env bash
# Garrison Outpost — SSH provisioning script.
#
# Streamed to a remote Mac over `ssh … bash -s` by the outpost-tailscale-host UI server.
# The server prepends `export GARRISON_HOST/GARRISON_TOKEN/GARRISON_MACHINE` so this runs
# with the pairing credentials already in the environment.
#
# It idempotently installs the garrison-outpost-bridge agent (clone, build, config,
# launchd). It is a self-contained mirror of scripts/bootstrap-outpost.sh (which lives on
# the Garrison host, not the remote), NOT a re-run of it. Steps that cannot be done purely
# over SSH (task-capable skills bundle, per-runtime prerequisites) are printed as honest
# TODO / skipped lines rather than silently omitted.
set -euo pipefail

BRIDGE_REPO="https://github.com/gongiskhan/garrison-outpost-bridge.git"
CONFIG_DIR="$HOME/.garrison-outpost"
INSTALL_DIR="$CONFIG_DIR/bridge"
LOG_DIR="$CONFIG_DIR/logs"
PLIST_LABEL="io.garrison.outpost"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ -n "${GARRISON_HOST:-}" ]  || fail "GARRISON_HOST not set (the provisioner should have exported it)"
[ -n "${GARRISON_TOKEN:-}" ] || fail "GARRISON_TOKEN not set"
MACHINE_NAME="${GARRISON_MACHINE:-$(hostname -s)}"

# The bootstrap host base arrives as http://…; the bridge dials ws://…/bridge.
case "$GARRISON_HOST" in
  http://*)  BRIDGE_URL="ws://${GARRISON_HOST#http://}" ;;
  https://*) BRIDGE_URL="wss://${GARRISON_HOST#https://}" ;;
  *)         BRIDGE_URL="$GARRISON_HOST" ;;
esac
case "$BRIDGE_URL" in
  *"/bridge") : ;;
  ws://*|wss://*) BRIDGE_URL="${BRIDGE_URL%/}/bridge" ;;
esac

echo "==> Garrison Outpost provisioning on $(hostname -s)"
echo "    machine: $MACHINE_NAME"
echo "    bridge:  $BRIDGE_URL"

# --- Prerequisites ---
echo "==> Checking prerequisites"
command -v git >/dev/null 2>&1 || fail "git is not installed on the remote"
command -v node >/dev/null 2>&1 || fail "node is not installed on the remote (Node.js 20+ required)"
node_major=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])" 2>/dev/null || echo 0)
[ "$node_major" -ge 20 ] 2>/dev/null || fail "Node.js 20+ required (found major v${node_major})"
if ! command -v tailscale >/dev/null 2>&1; then
  echo "    WARNING: tailscale not found — the bridge still connects if the host is reachable."
fi

# --- Clone or update ---
mkdir -p "$CONFIG_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> Updating bridge at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || fail "git pull failed"
else
  echo "==> Cloning bridge to $INSTALL_DIR"
  git clone "$BRIDGE_REPO" "$INSTALL_DIR" || fail "git clone failed"
fi

# --- Build ---
echo "==> Installing dependencies and building"
( cd "$INSTALL_DIR" && npm install --no-fund --no-audit && npm run build ) || fail "npm build failed"

# --- Config ---
echo "==> Writing $CONFIG_DIR/config.json"
umask 077
cat > "$CONFIG_DIR/config.json" <<JSON
{
  "host_url": "$BRIDGE_URL",
  "token": "$GARRISON_TOKEN",
  "machine_name": "$MACHINE_NAME"
}
JSON

# --- Launchd ---
mkdir -p "$HOME/Library/LaunchAgents"
if [ -f "$INSTALL_DIR/launchd/io.garrison.outpost.plist" ]; then
  echo "==> Installing launchd plist to $PLIST_PATH"
  chmod +x "$INSTALL_DIR/bin/garrison-outpost-bridge" 2>/dev/null || true
  sed \
    -e "s|__BRIDGE_PATH__|$INSTALL_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$INSTALL_DIR/launchd/io.garrison.outpost.plist" \
    > "$PLIST_PATH"
  echo "==> Loading service"
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" || echo "    WARNING: launchctl bootstrap failed — start it manually"
else
  echo "    WARNING: no launchd plist shipped by the bridge — skipping service install"
fi

# --- Task-capable extras (honest TODOs; not doable purely over SSH here) ---
echo "==> Task-capable outpost extras"
echo "    TODO: skills bundle — skipped (needs Armory path; not implementable purely over SSH)"
echo "    TODO: per-runtime prerequisites (Claude Code / uv / language toolchains) — skipped (needs Armory path)"

# --- Wait for ready ---
echo "==> Waiting for bridge to connect (up to 60s)…"
TODAY=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/$TODAY.log"
DEADLINE=$((SECONDS + 60))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if [ -f "$LOG_FILE" ] && grep -qF "[connection] ready" "$LOG_FILE"; then
    echo "==> Bridge connected. '$MACHINE_NAME' is now a Garrison Outpost."
    exit 0
  fi
  sleep 2
done
echo "WARNING: bridge did not confirm ready within 60s. Check $LOG_FILE — launchd will keep retrying."
exit 0
