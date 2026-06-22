#!/usr/bin/env bash
# coord-beads setup — ensure the pinned `bd` CLI is present, then install the
# owner-tagged user-scope SessionStart hook. Idempotent.
#
# Honors GARRISON_CLAUDE_SETTINGS_PATH (sandbox) via install-hooks.mjs.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINNED="1.0.5"

echo "[coord-beads] setup starting"

# 1) Ensure bd is present (self-unblock: try Homebrew, then npm). Pin recorded.
if ! command -v bd >/dev/null 2>&1; then
  echo "[coord-beads] bd not found — attempting install (pin $PINNED)"
  if command -v brew >/dev/null 2>&1; then
    brew install beads || true
  fi
  if ! command -v bd >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    npm install -g @beads/bd || true
  fi
fi

if ! command -v bd >/dev/null 2>&1; then
  echo "[coord-beads] ERROR: bd could not be installed automatically."
  echo "[coord-beads] Install it manually: 'brew install beads' or 'npm i -g @beads/bd' (pin $PINNED), then re-run setup."
  exit 1
fi

echo "[coord-beads] bd present: $(bd version 2>/dev/null || bd --version 2>/dev/null)"

# 2) Install the owner-tagged user-scope SessionStart hook.
node "$SCRIPT_DIR/install-hooks.mjs"

echo "[coord-beads] setup complete"
