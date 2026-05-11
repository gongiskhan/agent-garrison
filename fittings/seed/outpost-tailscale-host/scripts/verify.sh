#!/usr/bin/env bash
# Verify the outpost-host HTTP server is up and responding.
set -euo pipefail

GARRISON_OUTPOST_URL="${GARRISON_OUTPOST_URL:-http://127.0.0.1:3702}"

STATUS=$(curl -fsS --max-time 5 "$GARRISON_OUTPOST_URL/health" | grep -o '"ok":true' || true)
if [ "$STATUS" = '"ok":true' ]; then
  echo "ok"
else
  echo "FAIL: outpost-host /health did not return ok:true" >&2
  exit 1
fi
