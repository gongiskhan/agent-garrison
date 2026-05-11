#!/usr/bin/env bash
# Verify that the Garrison Outpost host server is reachable on port 3702.
# The server is started automatically when Garrison starts (npm start includes outpost-host.mjs).
set -euo pipefail

GARRISON_OUTPOST_URL="${GARRISON_OUTPOST_URL:-http://127.0.0.1:3702}"

RESPONSE=$(curl -fsS --max-time 5 "$GARRISON_OUTPOST_URL/health") || {
  echo "FAIL: outpost-host not reachable at $GARRISON_OUTPOST_URL" >&2
  echo "      Make sure Garrison is running (npm start includes outpost-host.mjs)." >&2
  exit 1
}
echo "outpost-host: $RESPONSE"
