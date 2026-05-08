#!/usr/bin/env bash
# Wrapper invoked by the scheduler. Resolves the Fitting install dir
# from $0 and runs `calendar.py sync` inside the venv.
set -euo pipefail
FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec uv run --directory "$FITTING_DIR" --quiet python scripts/calendar.py sync
