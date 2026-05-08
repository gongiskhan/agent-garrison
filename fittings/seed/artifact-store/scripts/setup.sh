#!/usr/bin/env bash
# artifact-store setup. Creates the storage root and standard namespaces.
# Idempotent: re-runs are safe.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"

STORAGE_ROOT="${GARRISON_ARTIFACTS_ROOT:-$COMPOSITION_DIR/${GARRISON_STORAGE_ROOT_REL:-artifacts}}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not on PATH; install Python 3.10+ and re-run" >&2
  exit 1
fi

GARRISON_ARTIFACTS_ROOT="$STORAGE_ROOT" python3 \
  "$FITTING_DIR/scripts/artifacts.py" init

echo "ok"
