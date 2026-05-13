#!/usr/bin/env bash
# tier-classifier setup — reuse the http-gateway SDK install if available.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"
GATEWAY_NM="$COMPOSITION_DIR/apm_modules/_local/http-gateway/node_modules"

cd "$FITTING_DIR"
if [ -d "node_modules/@anthropic-ai/claude-agent-sdk" ]; then
  echo "ok"
  exit 0
fi

if [ -d "$GATEWAY_NM/@anthropic-ai/claude-agent-sdk" ]; then
  ln -snf "$GATEWAY_NM" node_modules
  echo "ok"
  exit 0
fi

if command -v npm >/dev/null 2>&1; then
  npm install --omit=dev --no-audit --no-fund >/dev/null
  echo "ok"
  exit 0
fi

echo "tier-classifier setup: no SDK install path available" >&2
exit 1
