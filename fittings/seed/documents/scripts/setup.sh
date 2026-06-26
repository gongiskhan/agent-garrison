#!/usr/bin/env bash
# documents setup. documents is now self-contained — it vendors its OWN
# artifacts.py beside documents.py (the artifact-store Fitting was dropped). This
# just initialises the documents/ namespace so the first list call doesn't 404.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ARTIFACTS_CLI="${GARRISON_ARTIFACTS_CLI:-$FITTING_DIR/scripts/artifacts.py}"

if [ ! -f "$ARTIFACTS_CLI" ]; then
  echo "documents: vendored artifacts.py not found at $ARTIFACTS_CLI" >&2
  exit 1
fi

# Ensure the documents/ namespace exists. init is idempotent.
python3 "$ARTIFACTS_CLI" init --namespace documents >/dev/null

echo "ok"
