#!/usr/bin/env bash
# Slack channel Fitting setup. Validates the host and surfaces readiness hints.
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

missing=()
for var in SLACK_BOT_TOKEN SLACK_SIGNING_SECRET; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

# Credentials are connection state, not an install prerequisite. A composition
# may intentionally carry Slack alongside a working Web channel before a Slack
# workspace has been connected. Keep setup idempotent and non-blocking, while
# putting a conspicuous warning on stdout (successful setup stderr is not shown
# by the runner). The adapter itself still refuses to start without both values.
if [ "${#missing[@]}" -ne 0 ]; then
  echo "WARNING: slack-channel is not ready; missing ${missing[*]}. Add them in the Garrison Vault before starting Slack. Other channels remain available."
  readiness="Slack inactive until credentials are configured"
else
  readiness="credentials present"
fi

if command -v cloudflared >/dev/null 2>&1; then
  echo "tip: expose the adapter publicly with \"cloudflared tunnel --url http://127.0.0.1:${SLACK_PORT:-29512}\""
fi

echo "slack-channel setup ok (node ${node_major}; ${readiness})"
