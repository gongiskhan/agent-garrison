#!/usr/bin/env bash
# Verify the workspaces fitting is intact. Read-only: checks that the manifest
# and the declared view entry exist. No directories are created, nothing is
# written — workspaces has no server-side runtime to probe.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$FITTING_DIR/apm.yml" ]; then
  echo "apm.yml missing" >&2
  exit 1
fi

if [ ! -f "$FITTING_DIR/ui/WorkspaceView.tsx" ]; then
  echo "ui/WorkspaceView.tsx missing" >&2
  exit 1
fi

echo "ok"
