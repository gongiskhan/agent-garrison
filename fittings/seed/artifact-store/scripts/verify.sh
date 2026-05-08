#!/usr/bin/env bash
# Verify the artifact-store storage root resolves and is writable.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! python3 "$FITTING_DIR/scripts/artifacts.py" --probe; then
  echo "probe failed" >&2
  exit 1
fi
