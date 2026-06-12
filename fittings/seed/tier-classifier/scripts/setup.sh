#!/usr/bin/env bash
# tier-classifier setup. The model is reached via @garrison/claude-pty, which
# resolves from the repo-root node_modules (walk-up) — no per-fitting install
# needed. Verify it's importable.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$FITTING_DIR"
if node --input-type=module -e "await import('@garrison/claude-pty')" >/dev/null 2>&1; then
  echo "ok"
  exit 0
fi

echo "tier-classifier setup: @garrison/claude-pty not resolvable from $FITTING_DIR" >&2
exit 1
