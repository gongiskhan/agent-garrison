#!/usr/bin/env bash
# Thin wrapper called by the scheduler on each tick.
set -euo pipefail
FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# cwd is set to the composition dir by the scheduler.
python3 "$FITTING_DIR/scripts/sync.py" once
