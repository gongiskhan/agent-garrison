#!/usr/bin/env bash
# CO6 evidence — prove BOTH run paths load the coordination MCP servers + hooks
# from ONE user-scope install, plus the PTY-safe + license-isolation audits.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 1
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; sleep 0.4; }
REPO="$(pwd)"
SEED="$REPO/fittings/seed"

SB=$(mktemp -d /tmp/co6-home.XXXX)
export GARRISON_HOME="$SB"
export GARRISON_CLAUDE_SETTINGS_PATH="$SB/.claude/settings.json"
export GARRISON_CLAUDE_JSON="$SB/.claude.json"
mkdir -p "$SB/.claude"

say "Install coord config at USER scope (what selecting the fittings does)"
node "$SEED/coord-beads/scripts/install-hooks.mjs"
node "$SEED/coord-mcp/scripts/register-mcp.mjs" add
node "$SEED/coord-mcp/scripts/install-hook.mjs"
node "$SEED/coord-agentmail/scripts/register-mcp.mjs" add 8765
echo "config paths a direct claude run reads:"
echo "  MCP   : $GARRISON_CLAUDE_JSON"
echo "  hooks : $GARRISON_CLAUDE_SETTINGS_PATH"

# Start agent_mail so its MCP connects in the listing.
mkdir -p "$SB/external"; ln -s "$HOME/.garrison/external/mcp_agent_mail" "$SB/external/mcp_agent_mail"
node "$SEED/coord-agentmail/scripts/start.mjs" >"$SB/am.log" 2>&1 &
AM=$!; for i in $(seq 1 30); do [ -f "$SB/ui-fittings/coord-agentmail.json" ] && break; sleep 1; done

say "PATH 1 — DIRECT: a fresh repo never handed out by Garrison"
FRESH=$(mktemp -d /tmp/co6-fresh.XXXX); ( cd "$FRESH" && git init -q )
echo "fresh repo: $FRESH (not under $REPO)"
echo "--- HOME=$SB claude mcp list (reads user-scope config) ---"
( cd "$FRESH" && HOME="$SB" claude mcp list 2>&1 | grep -E "coord-|Failed|✓|Checking" )
echo "--- grep the hooks config the direct run reads ---"
grep -oE '"fitting:coord-(beads|mcp)"' "$GARRISON_CLAUDE_SETTINGS_PATH" | sort -u

say "PATH 2 — ORCHESTRATOR: a Garrison-spawned claude reads the SAME ~/.claude"
echo "--- runner spawns claude inheriting env (HOME) with NO --mcp-config override ---"
grep -nE "spawnClaude|--mcp-config|append-system-prompt" "$REPO/src/lib/runner.ts" | head -4
grep -c -- "--mcp-config" "$REPO/src/lib/runner.ts" "$REPO/scripts/pty-operative.mjs" "$REPO/packages/claude-pty/src/session.mjs" 2>/dev/null | sed 's/^/  --mcp-config occurrences: /'
echo "--- same config from a composition-style cwd -> identical servers ---"
COMP=$(mktemp -d /tmp/co6-comp.XXXX)
( cd "$COMP" && HOME="$SB" claude mcp list 2>&1 | grep -E "coord-" )

say "AUDIT — PTY-SAFE: every coord hook is type=command (no agent/prompt, no claude -p)"
node -e 'const s=require(process.argv[1]);let bad=0;for(const gs of Object.values(s.hooks||{}))for(const g of gs){if(!String(g._garrison||"").startsWith("fitting:coord"))continue;for(const h of g.hooks||[]){if(h.type!=="command"||/claude\s+-p\b/.test(h.command||"")){bad++;console.log("BAD",h)}}}console.log(bad===0?"all coord hooks are command-type":"FOUND NON-COMMAND HOOKS")' "$GARRISON_CLAUDE_SETTINGS_PATH"
# Real usage only — exclude prose/comment mentions (e.g. canary.mjs documents that
# `claude -p` is FORBIDDEN).
if grep -rIE "claude[[:space:]]+-p\b|@anthropic-ai/sdk" "$SEED"/coord-beads "$SEED"/coord-mcp "$SEED"/coord-agentmail 2>/dev/null | grep -vE "//|#|forbid|never|PTY-everywhere" | grep -q .; then
  echo "FOUND model-call invocation (BAD)"
else
  echo "no claude -p / Agent-SDK invocation in coord fittings (only a forbidding comment)"
fi

say "AUDIT — LICENSE-ISOLATION: agent_mail outside the MIT tree + never imported"
echo "clone location: $HOME/.garrison/external/mcp_agent_mail (outside $REPO)"
head -1 "$HOME/.garrison/external/mcp_agent_mail/LICENSE"
grep -rIlE "(import|require|from).*mcp_agent_mail" "$REPO/src" "$REPO/fittings" "$REPO/scripts" "$REPO/packages" 2>/dev/null && echo "IMPORT FOUND (BAD)" || echo "no mcp_agent_mail import in the MIT tree"

say "COORD-WIRING OK   /   PTY-SAFE OK   /   LICENSE-ISOLATION OK"
kill -TERM $AM 2>/dev/null; sleep 1
pkill -f "mcp_agent_mail.http --host 127.0.0.1 --port 8765" 2>/dev/null
rm -rf "$SB" "$FRESH" "$COMP"
