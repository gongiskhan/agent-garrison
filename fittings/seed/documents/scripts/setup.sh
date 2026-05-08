#!/usr/bin/env bash
# documents setup. Confirms the artifact store is reachable and ensures the
# documents/ namespace exists. Storage is owned by artifact-store; this just
# pokes it on a fresh composition so the very first list call doesn't 404.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"

ARTIFACTS_CLI="${GARRISON_ARTIFACTS_CLI:-$COMPOSITION_DIR/apm_modules/_local/artifact-store/scripts/artifacts.py}"

if [ ! -f "$ARTIFACTS_CLI" ]; then
  echo "documents requires the artifact-store Fitting; install it and re-run" >&2
  exit 1
fi

# Ensure the documents/ namespace exists. init is idempotent.
python3 "$ARTIFACTS_CLI" init --namespace documents >/dev/null

echo "ok"
