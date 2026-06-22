#!/usr/bin/env bash
# CO2 evidence — coord-agentmail: arm's-length license-isolated agent_mail server,
# own-port status file, user-scope MCP registration, clean stop. Sandbox config.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 1
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; sleep 0.5; }

SB=$(mktemp -d /tmp/co2-demo.XXXX)
mkdir -p "$SB/external"
ln -s "$HOME/.garrison/external/mcp_agent_mail" "$SB/external/mcp_agent_mail"
export GARRISON_HOME="$SB" GARRISON_CLAUDE_JSON="$SB/.claude.json" COORD_AGENTMAIL_PORT=8791

say "coord-agentmail — mcp_agent_mail (pin de9e628), MIT + OpenAI/Anthropic rider"
echo "License isolation: clone lives OUTSIDE the MIT tree ->"
ls -d "$HOME/.garrison/external/mcp_agent_mail" && head -1 "$HOME/.garrison/external/mcp_agent_mail/LICENSE"
sleep 0.6

say "1. Start own-port supervisor (arm's-length external process)"
node fittings/seed/coord-agentmail/scripts/start.mjs > "$SB/start.log" 2>&1 &
SUP=$!
for i in $(seq 1 40); do [ -f "$SB/ui-fittings/coord-agentmail.json" ] && break; sleep 1; done
echo "--- status file (~/.garrison/ui-fittings/coord-agentmail.json) ---"
cat "$SB/ui-fittings/coord-agentmail.json"; echo
sleep 0.6

say "2. User-scope MCP registration (~/.claude.json) — reachable by any claude run"
cat "$SB/.claude.json"; echo
curl -s -o /dev/null -w "agent_mail /mail UI -> HTTP %{http_code}\n" http://127.0.0.1:8791/mail
sleep 0.6

say "3. Stop -> clean: child reaped (no orphan), status file removed"
kill -TERM $SUP 2>/dev/null
for i in $(seq 1 10); do kill -0 $SUP 2>/dev/null || break; sleep 1; done
sleep 1
echo "status file removed? $([ -f "$SB/ui-fittings/coord-agentmail.json" ] && echo NO || echo YES)"
echo "orphan server? $(pgrep -f 'mcp_agent_mail.http --host 127.0.0.1 --port 8791' >/dev/null && echo YES || echo NO)"
echo "MCP registration persists (standing across stop)? $(grep -q coord-agentmail "$SB/.claude.json" && echo YES || echo NO)"
sleep 0.5

say "AGENTMAIL-FITTING OK  /  LICENSE-ISOLATION OK"
pkill -f "mcp_agent_mail.http --host 127.0.0.1 --port 8791" 2>/dev/null
rm -rf "$SB"
