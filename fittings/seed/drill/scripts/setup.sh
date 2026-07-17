#!/usr/bin/env bash
# Drill fitting setup: install deps (js-yaml, @medv/finder, css-selector-generator)
# and build the authoring/results UI. Idempotent.
set -euo pipefail

fitting_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 18+ and re-run" >&2
  exit 1
fi

cd "$fitting_dir"
if [ -f package.json ]; then
  npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || npm install
fi

node ui/build.mjs

# Ensure the target app repo's drills/ dir exists (defaults to cwd — the
# composition sets GARRISON_DRILL_TARGET_REPO for a real target app).
mkdir -p "${GARRISON_DRILL_TARGET_REPO:-.}/drills/pages"

echo "drill setup ok"
