#!/usr/bin/env bash
# coord-mcp verify (read-only) — the server boots + lists its tools, and the stdio
# MCP server is registered in ~/.claude.json. Prints "ok". Honors GARRISON_CLAUDE_JSON.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CJ="${GARRISON_CLAUDE_JSON:-$HOME/.claude.json}"

probe="$(node "$SCRIPT_DIR/server.mjs" --probe 2>/dev/null)"
if ! printf '%s' "$probe" | grep -q '"ok":true'; then
  echo "verify-failed: server --probe did not report ok"
  exit 1
fi
if ! printf '%s' "$probe" | grep -q 'begin_planning'; then
  echo "verify-failed: begin_planning tool not advertised"
  exit 1
fi
if [ -f "$CJ" ] && ! grep -q '"coord-mcp"' "$CJ"; then
  echo "verify-failed: coord-mcp not registered in $CJ"
  exit 1
fi

# The coordination hook is installed (owner-tagged).
SETTINGS="${GARRISON_CLAUDE_SETTINGS_PATH:-$HOME/.claude/settings.json}"
if [ -f "$SETTINGS" ] && ! grep -q 'fitting:coord-mcp' "$SETTINGS"; then
  echo "verify-failed: coord-mcp hook not installed in $SETTINGS"
  exit 1
fi

echo "ok"
