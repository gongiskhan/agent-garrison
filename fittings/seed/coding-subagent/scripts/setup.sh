#!/usr/bin/env bash
# coding-subagent setup. The SDK is large; reuse the http-gateway fitting's
# install when available, fall back to npm install.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"

# Ensure logs/ and data/ exist. T4 tails files in logs/.
mkdir -p "$COMPOSITION_DIR/logs"
mkdir -p "$COMPOSITION_DIR/data"

# SDK resolution preference order:
#   1. Already resolvable from FITTING_DIR (already installed)
#   2. Sibling http-gateway fitting (avoid duplicate ~100MB install)
#   3. npm install in FITTING_DIR (slow path)
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

echo "coding-subagent setup: no SDK install path available" >&2
exit 1
