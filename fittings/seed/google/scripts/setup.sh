#!/usr/bin/env bash
# Google connector setup. The executor is Node (no Python/venv). OAuth is sealed
# in the keychain Vault; the engine injects a fresh access token per call, so
# setup does NOT require live credentials — a connector is "Not connected" until
# the user completes OAuth consent.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 18+ and re-run" >&2
  exit 1
fi

echo "google connector setup ok (connect via OAuth to seal a grant in the Vault)"
