#!/usr/bin/env bash
# Spotify connector setup. The executor is Node (no Python dependency). Auth is
# an OAuth2 grant sealed in the Vault and delivered as a freshly-refreshed access
# token at call time, so setup does NOT hard-fail when it is absent — a connector
# is "Not connected" until the user connects it via OAuth; a call then returns
# awaiting_connector at runtime.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 18+ and re-run" >&2
  exit 1
fi

if [ -z "${SPOTIFY_OAUTH_CLIENT_ID:-}" ] || [ -z "${SPOTIFY_OAUTH_CLIENT_SECRET:-}" ]; then
  echo "spotify setup ok (not yet connected — seal SPOTIFY_OAUTH_CLIENT_ID/SECRET in the Vault, then Connect via OAuth)"
else
  echo "spotify setup ok (client credentials present — Connect via OAuth to finish)"
fi
