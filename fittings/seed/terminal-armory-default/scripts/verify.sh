#!/usr/bin/env bash
# Verify node-pty spawn-helper is executable. Does not start the WS server
# (that is handled lazily by Garrison's ensureWsServer()).
set -e
HELPER="$(node -e "require.resolve('node-pty')" 2>/dev/null | sed 's|/lib/index.js||')/build/Release/spawn-helper"
if [ -f "$HELPER" ] && [ -x "$HELPER" ]; then
  echo ok
elif [ ! -f "$HELPER" ]; then
  # Not on darwin or node-pty installed differently — acceptable
  echo ok
else
  echo "spawn-helper exists but is not executable: $HELPER" >&2
  exit 1
fi
