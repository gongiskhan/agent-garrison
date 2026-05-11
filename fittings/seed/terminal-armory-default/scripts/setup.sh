#!/usr/bin/env bash
# Ensure node-pty spawn-helper has execute permission.
# The npm-distributed darwin prebuilds ship without the +x bit.
set -e
HELPER="$(node -e "require.resolve('node-pty')" 2>/dev/null | sed 's|/lib/index.js||')/build/Release/spawn-helper"
if [ -f "$HELPER" ]; then
  chmod +x "$HELPER"
  echo "spawn-helper +x applied: $HELPER"
else
  echo "spawn-helper not found at $HELPER; skipping chmod (may not be on darwin)"
fi
