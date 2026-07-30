#!/usr/bin/env bash
# Omi channel Fitting setup. Validates the host and surfaces readiness hints.
# Credentials are connection state, not an install prerequisite (slack-channel
# precedent): a composition may carry the Omi channel with every pipe off
# before any Omi app exists. Idempotent and non-blocking.
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
for var in OMI_APP_ID OMI_APP_SECRET OMI_IMPORT_API_KEY OMI_WEBHOOK_SECRET; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ "${#missing[@]}" -ne 0 ]; then
  echo "WARNING: omi-channel is not connected; missing ${missing[*]}. Seal them in the Garrison Vault (see HUMAN_SETUP.md) before enabling any pipe. All pipes stay off without them."
  readiness="Omi inactive until credentials are configured"
else
  readiness="credentials present"
fi

echo "omi-channel setup ok (node ${node_major}; ${readiness})"
