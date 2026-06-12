#!/usr/bin/env bash
# coding-subagent setup. The model is reached via @garrison/claude-pty (resolves
# from repo-root node_modules via walk-up) — no SDK install. Ensure log/data
# dirs exist and the lib is importable.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"

mkdir -p "$COMPOSITION_DIR/logs"
mkdir -p "$COMPOSITION_DIR/data"

cd "$FITTING_DIR"
if node --input-type=module -e "await import('@garrison/claude-pty')" >/dev/null 2>&1; then
  echo "ok"
  exit 0
fi

echo "coding-subagent setup: @garrison/claude-pty not resolvable from $FITTING_DIR" >&2
exit 1
