#!/usr/bin/env bash
# CO4+CO5 evidence — coordination observability: liveness, per-repo activity,
# heartbeat tail, planning-lock state, and the canary self-test. Sandbox GARRISON_HOME.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 1
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; sleep 0.5; }
SCR="fittings/seed/coord-mcp/scripts"

SB=$(mktemp -d /tmp/co5-demo.XXXX); export GARRISON_HOME="$SB"
mkdir -p "$SB/external"; ln -s "$HOME/.garrison/external/mcp_agent_mail" "$SB/external/mcp_agent_mail"
export GARRISON_CLAUDE_HOME="$SB/claude"; mkdir -p "$SB/claude/projects"
REPO="/tmp/coord-observe-demo-repo"

say "Start agent_mail (so liveness shows it UP)"
COORD_AGENTMAIL_PORT=8793 node "$SCR/../../coord-agentmail/scripts/start.mjs" >"$SB/am.log" 2>&1 &
AM=$!; for i in $(seq 1 30); do [ -f "$SB/ui-fittings/coord-agentmail.json" ] && break; sleep 1; done

say "coord canary — self-test write -> detect -> inject (also writes a heartbeat)"
node "$SCR/coord.mjs" canary

say "Seed a planning lock: A holds it, B waits"
seed() { printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" | COORD_SESSION="$1" node "$SCR/server.mjs" >/dev/null; }
seed sessionA begin_planning "{\"repo\":\"$REPO\",\"summary\":\"refactor the gateway\"}"
seed sessionB begin_planning "{\"repo\":\"$REPO\",\"summary\":\"rework the runner\"}"   # -> WAIT (records waiter)

say "coord status — liveness + per-repo activity + planning-lock state"
node "$SCR/coord.mjs" status

say "coord status --tail — hook heartbeat (inject/read evidence)"
node "$SCR/coord.mjs" status --tail

say "COORD-OBSERVE OK"
kill -TERM $AM 2>/dev/null; sleep 1
pkill -f "mcp_agent_mail.http --host 127.0.0.1 --port 8793" 2>/dev/null
rm -rf "$SB"
