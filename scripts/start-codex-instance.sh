#!/usr/bin/env bash
# Compatibility shim — superseded by scripts/garrison-instance.sh.
#
# This script used to hold the codex instance's whole env projection. That
# projection is now profile-driven (prod|dev|codex) in garrison-instance.sh, so
# the codex identity is just one profile among three. Kept because other
# sessions, notes and docs still invoke this path by name.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/garrison-instance.sh" codex "${1:-start}"
