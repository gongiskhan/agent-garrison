#!/usr/bin/env bash
# Automations fitting setup: install the fitting's own deps (js-yaml) so the
# own-port server can read/write YAML automations. Idempotent.
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

# Ensure the machine-local automations dir exists.
mkdir -p "${GARRISON_AUTOMATIONS_DIR:-$HOME/.garrison/automations}/briefs"
mkdir -p "${GARRISON_AUTOMATIONS_DIR:-$HOME/.garrison/automations}/runs"

echo "automations setup ok"
