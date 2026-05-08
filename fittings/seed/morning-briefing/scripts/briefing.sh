#!/usr/bin/env bash
# Wrapper invoked by the scheduler. Stable absolute path = stable
# scheduler.command string across re-installs.
set -euo pipefail
FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$FITTING_DIR/scripts/briefing.py" fire
