#!/usr/bin/env bash
set -euo pipefail

BRIDGE_REPO="https://github.com/gongiskhan/garrison-outpost-bridge.git"
INSTALL_DIR="$HOME/.garrison-outpost/bridge"
CONFIG_DIR="$HOME/.garrison-outpost"
LOG_DIR="$CONFIG_DIR/logs"
PLIST_LABEL="io.garrison.outpost"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

: "${GARRISON_HOST:?GARRISON_HOST is required (e.g. ws://100.x.x.x:3702/bridge)}"
: "${GARRISON_TOKEN:?GARRISON_TOKEN is required}"
MACHINE_NAME="${GARRISON_MACHINE:-$(hostname -s)}"

echo "==> Garrison Outpost Bootstrap"
echo "    host:    $GARRISON_HOST"
echo "    machine: $MACHINE_NAME"
echo

# --- Prerequisites ---
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Install Node.js 20+ and re-run." >&2
  exit 1
fi
node_major=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if (( node_major < 20 )); then
  echo "ERROR: Node.js 20+ required (found v${node_major})." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is not installed." >&2
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "WARNING: tailscale not found — bridge will connect if the host is reachable, but Tailscale is recommended."
fi

# --- Clone or update ---
mkdir -p "$CONFIG_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> Updating bridge at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "==> Cloning bridge to $INSTALL_DIR"
  git clone "$BRIDGE_REPO" "$INSTALL_DIR"
fi

# --- Build ---
echo "==> Installing dependencies and building"
(cd "$INSTALL_DIR" && npm install --no-fund --no-audit && npm run build)

# --- Config ---
echo "==> Writing $CONFIG_DIR/config.json"
cat > "$CONFIG_DIR/config.json" <<JSON
{
  "host_url": "$GARRISON_HOST",
  "token": "$GARRISON_TOKEN",
  "machine_name": "$MACHINE_NAME"
}
JSON

# --- Launchd plist ---
mkdir -p "$HOME/Library/LaunchAgents"
echo "==> Installing launchd plist to $PLIST_PATH"
chmod +x "$INSTALL_DIR/bin/garrison-outpost-bridge"
sed \
  -e "s|__BRIDGE_PATH__|$INSTALL_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$INSTALL_DIR/launchd/io.garrison.outpost.plist" \
  > "$PLIST_PATH"

# --- Load ---
echo "==> Loading service"
launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

# --- Wait for ready ---
echo "==> Waiting for bridge to connect (up to 60s)…"
TODAY=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/$TODAY.log"
DEADLINE=$((SECONDS + 60))

while (( SECONDS < DEADLINE )); do
  if [[ -f "$LOG_FILE" ]] && grep -qF "[connection] ready" "$LOG_FILE"; then
    echo "==> Bridge connected successfully."
    echo "    Machine '$MACHINE_NAME' is now registered as a Garrison Outpost."
    exit 0
  fi
  sleep 2
done

echo "WARNING: Bridge did not confirm ready within 60s." >&2
echo "  Check logs at $LOG_DIR/$TODAY.log" >&2
echo "  The service is still running — launchd will keep retrying the connection." >&2
exit 0
