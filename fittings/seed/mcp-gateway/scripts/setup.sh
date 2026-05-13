#!/usr/bin/env bash
# mcp-gateway setup — install @modelcontextprotocol/sdk.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$FITTING_DIR"
if [ -d "node_modules/@modelcontextprotocol/sdk" ]; then
  echo "ok"
  exit 0
fi

if command -v npm >/dev/null 2>&1; then
  npm install --omit=dev --no-audit --no-fund >/dev/null
  echo "ok"
  exit 0
fi

echo "mcp-gateway setup: npm not found" >&2
exit 1
