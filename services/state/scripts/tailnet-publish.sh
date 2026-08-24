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

# tailscale >=1.98 requires root (or a sudo-capable operator) for EVERY serve
# config write - the operator flag alone stopped being enough. ts_serve tries
# plain first (older daemons, macOS), then sudo -n (the committed sudoers
# NOPASSWD entry for /usr/bin/tailscale), then says exactly what to fix.
ts_serve() {
  if tailscale serve "$@" >/dev/null 2>&1; then return 0; fi
  if sudo -n tailscale serve "$@" >/dev/null 2>&1; then return 0; fi
  echo "tailscale serve $* refused - need root or the sudoers entry:" >&2
  echo "  echo 'ggomes ALL=(root) NOPASSWD: /usr/bin/tailscale' | sudo tee /etc/sudoers.d/tailscale-operator" >&2
  return 1
}
ts_serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$STATE_PORT"
if [ "${GARRISON_PUBLISH_AGENTMAIL:-0}" = "1" ]; then
  ts_serve --bg --https="$AGENTMAIL_SERVE_PORT" "http://127.0.0.1:$AGENTMAIL_PORT"
fi

# AllowFunnel is the truth; `funnel status` prints the whole serve table and
# false-positives on tailnet-only rows.
FUNNELED="$(tailscale serve status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const f=JSON.parse(d).AllowFunnel||{};console.log(Object.keys(f).filter(k=>f[k]).join(" "))}catch{console.log("")}})')"
for bad in "$SERVE_PORT" "$AGENTMAIL_SERVE_PORT"; do
  case " $FUNNELED " in
    *":$bad "*|*":$bad") echo "FATAL: port $bad is FUNNELED — the state service must NEVER be public" >&2; exit 1 ;;
  esac
done

HOST="$(tailscale status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{console.log("")}})')"
echo "state service published at https://${HOST}:${SERVE_PORT}"
