#!/usr/bin/env bash
# WhatsApp connector setup. The executor is Node (no Python dependency). Secrets
# are sealed in the Vault and delivered scoped at call time, so setup does NOT
# hard-fail when they are absent — a connector is "Not connected" until the user
# connects it; the automation engine pauses (awaiting_connector) at runtime.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 18+ and re-run" >&2
  exit 1
fi

if [ -z "${WHATSAPP_ACCESS_TOKEN:-}" ] || [ -z "${WHATSAPP_PHONE_NUMBER_ID:-}" ]; then
  echo "whatsapp setup ok (not yet connected — seal WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID in the Vault to connect)"
else
  echo "whatsapp setup ok (connected)"
fi
