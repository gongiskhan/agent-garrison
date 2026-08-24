#!/usr/bin/env bash
# Publish the state service (and the shared agent-mail instance) to the
# tailnet — COMMITTED, run by the unit's ExecStartPost. Hand-run serve state is
# exactly the /bridge trap: a mapping nobody can reproduce from the checkout.
#
# HARD ASSERTION: neither port may be funneled. A funnel would put the mesh's
# state (and secrets endpoint) on the PUBLIC INTERNET behind nothing but a
# bearer token.
set -euo pipefail

STATE_PORT="${GARRISON_STATE_PORT:-8460}"
AGENTMAIL_PORT="${GARRISON_AGENTMAIL_PORT:-28765}"
# Same serve-port formula as scripts/tailnet-serve-views.mjs — uniform across
# nodes, so peers can compute each other's URLs without asking.
SERVE_PORT=$((8400 + STATE_PORT % 1000))
AGENTMAIL_SERVE_PORT=$((8400 + AGENTMAIL_PORT % 1000))

tailscale serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$STATE_PORT" >/dev/null
if [ "${GARRISON_PUBLISH_AGENTMAIL:-0}" = "1" ]; then
  tailscale serve --bg --https="$AGENTMAIL_SERVE_PORT" "http://127.0.0.1:$AGENTMAIL_PORT" >/dev/null
fi

if tailscale funnel status 2>/dev/null | grep -qE ":($SERVE_PORT|$AGENTMAIL_SERVE_PORT)\b"; then
  echo "FATAL: a funnel names the state or agent-mail serve port — the state service must NEVER be public" >&2
  exit 1
fi

HOST="$(tailscale status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{console.log("")}})')"
echo "state service published at https://${HOST}:${SERVE_PORT}"
