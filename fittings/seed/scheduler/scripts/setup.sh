#!/usr/bin/env bash
# Scheduler Fitting setup. Validates Node ≥ 18.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 18+ and re-run" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 18 ]; then
  echo "node ${node_major} is too old; need 18+" >&2
  exit 1
fi

echo "scheduler setup ok (node $(node -v))"
