#!/usr/bin/env bash
# Verify the vault-sync Fitting is configured correctly.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$DIR/sync.py" --probe
