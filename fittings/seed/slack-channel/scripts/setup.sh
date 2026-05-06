#!/usr/bin/env bash
# Slack channel Fitting setup. Validates Node, env, and surfaces tunnel hints.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH; install Node.js 20+ and re-run" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".").shift()')"
if [ "$node_major" -lt 20 ]; then
  echo "node ${node_major} is too old; need 20+" >&2
  exit 1
fi

missing=0
for var in SLACK_BOT_TOKEN SLACK_SIGNING_SECRET; do
  if [ -z "${!var:-}" ]; then
    echo "${var} is not set; resolve via vault. See instructions.md." >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

if command -v cloudflared >/dev/null 2>&1; then
  echo "tip: expose the adapter publicly with \"cloudflared tunnel --url http://127.0.0.1:${SLACK_PORT:-9512}\""
fi

echo "slack-channel setup ok (node ${node_major})"
