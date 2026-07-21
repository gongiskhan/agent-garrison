#!/usr/bin/env bash
# Lightweight readiness probe used by the composition verify hook. Prints "ok"
# only when every script is present and restic is on PATH; otherwise prints a
# clear, actionable message and exits non-zero. Accepts an optional --probe flag
# for parity with the other Fitting probes.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for s in env.sh backup.sh prune.sh verify.sh status.sh; do
  if [ ! -f "$SCRIPT_DIR/$s" ]; then
    echo "missing script: $s"
    exit 1
  fi
done

if ! command -v restic >/dev/null 2>&1; then
  echo "restic is not on PATH; run: sudo apt-get install -y restic"
  exit 1
fi

echo "ok"
