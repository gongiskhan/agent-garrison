#!/usr/bin/env bash
# Verify documents Fitting can reach its CLI and the artifact store.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! python3 "$FITTING_DIR/scripts/documents.py" --probe; then
  echo "documents probe failed" >&2
  exit 1
fi
