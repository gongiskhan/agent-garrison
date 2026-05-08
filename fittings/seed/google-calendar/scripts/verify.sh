#!/usr/bin/env bash
# Verifies google-calendar Fitting is wired correctly.
# Real verification = the token can refresh + a smoke API call works.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="$HOME/.garrison/google-calendar/token.json"

if [ ! -f "$TOKEN" ]; then
  echo "missing token at $TOKEN; run setup" >&2
  exit 1
fi

# Mode check (macOS uses stat -f %A; Linux uses stat -c %a).
if [ "$(uname)" = "Darwin" ]; then
  mode="$(stat -f '%A' "$TOKEN")"
else
  mode="$(stat -c '%a' "$TOKEN")"
fi
if [ "$mode" != "600" ]; then
  echo "token at $TOKEN has mode $mode; expected 600" >&2
  exit 1
fi

# Probe: refresh + events.list maxResults=1.
if ! uv run --directory "$FITTING_DIR" --quiet python scripts/calendar.py --probe; then
  echo "probe failed" >&2
  exit 1
fi

echo "ok"
