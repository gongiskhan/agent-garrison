#!/usr/bin/env bash
# Verify the CLI is importable and the outpost-host is reachable.
# Exit 0 + print "ok" when the probe passes; exit 1 otherwise.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$DIR/outpost.py" --probe
