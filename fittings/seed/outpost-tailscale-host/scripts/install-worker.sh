#!/usr/bin/env bash
# Install or repair Garrison's pull-based Outpost worker on a Mac.
#
# This script is served by the Outpost host and is deliberately independent of
# the external bridge implementation. It consumes only public files from this
# Fitting and writes the machine bearer token to an owner-only config file. The
# launchd plist receives the config PATH, never the token itself.
set -euo pipefail

fail() { echo "ERROR: $*" >&2; exit 1; }

[ -n "${GARRISON_DISPATCH_URL:-}" ] || fail "GARRISON_DISPATCH_URL is required (public HTTPS tailnet URL of Garrison)"
[ -n "${GARRISON_TOKEN:-}" ] || fail "GARRISON_TOKEN is required"
[ -n "${GARRISON_MACHINE:-}" ] || fail "GARRISON_MACHINE is required"
[ -n "${GARRISON_WORKER_ASSET_BASE:-}" ] || fail "GARRISON_WORKER_ASSET_BASE is required"

WORKER_VERSION="${GARRISON_WORKER_VERSION:-0.2.0}"
CONFIG_DIR="$HOME/.garrison-outpost"
BUNDLE_DIR="$CONFIG_DIR/worker-bundles/$WORKER_VERSION"
CONFIG_PATH="$CONFIG_DIR/worker.json"
LOG_DIR="$CONFIG_DIR/logs"
PLIST_LABEL="io.garrison.outpost-worker"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

command -v curl >/dev/null 2>&1 || fail "curl is not installed"
command -v node >/dev/null 2>&1 || fail "node is not installed (Node.js 20+ required)"
command -v npm >/dev/null 2>&1 || fail "npm is not installed"
NODE_BIN="$(node -p 'process.execPath')"
NPM_BIN="$(command -v npm)"
node_major="$($NODE_BIN -e "process.stdout.write(process.version.slice(1).split('.')[0])" 2>/dev/null || echo 0)"
[ "$node_major" -ge 20 ] 2>/dev/null || fail "Node.js 20+ required (found major v${node_major})"

echo "==> Installing Garrison Outpost worker $WORKER_VERSION"
umask 077
mkdir -p "$BUNDLE_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"

for asset in worker.mjs materialize.mjs personal-workspace.mjs runtime-adapters.mjs package.json package-lock.json; do
  echo "    fetch $asset"
  curl -fsSL "${GARRISON_WORKER_ASSET_BASE%/}/$asset" -o "$BUNDLE_DIR/$asset" || fail "could not fetch $asset"
done

echo "==> Installing pinned worker dependencies"
( cd "$BUNDLE_DIR" && "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund ) || fail "worker dependency install failed"

echo "==> Writing owner-only worker config"
export GARRISON_WORKER_CONFIG_PATH="$CONFIG_PATH"
export GARRISON_WORKER_WORKDIR="$CONFIG_DIR/work"
"$NODE_BIN" <<'NODE'
const fs = require("node:fs");
const config = {
  machine: process.env.GARRISON_MACHINE,
  dispatchUrl: process.env.GARRISON_DISPATCH_URL.replace(/\/+$/, ""),
  token: process.env.GARRISON_TOKEN,
  workdir: process.env.GARRISON_WORKER_WORKDIR,
  pollSeconds: 15
};
fs.writeFileSync(process.env.GARRISON_WORKER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(process.env.GARRISON_WORKER_CONFIG_PATH, 0o600);
NODE

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$BUNDLE_DIR/worker.mjs</string>
    <string>--config</string>
    <string>$CONFIG_PATH</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/worker.stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/worker.stderr.log</string>
</dict>
</plist>
PLIST
chmod 0644 "$PLIST_PATH"

echo "==> Loading worker launchd service"
launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
# `launchctl disable` survives plist deletion and bootout. A repair must undo
# that durable bit before bootstrap or launchd returns an opaque I/O error.
launchctl enable "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" || fail "launchctl bootstrap failed"
launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true

echo "==> Worker installed. Readiness will appear in Garrison after its first pulse."
echo "    Model credentials were not copied. If this Mac is not signed in locally, the worker will report degraded."
