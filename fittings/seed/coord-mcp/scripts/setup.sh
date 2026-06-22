#!/usr/bin/env bash
# coord-mcp setup — register the planning-gate stdio MCP server at user scope so
# every claude run (direct + orchestrator) gets begin_planning/end_planning + the
# intent/digest tools. Idempotent. Honors GARRISON_CLAUDE_JSON (sandbox).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[coord-mcp] setup starting"
if ! command -v node >/dev/null 2>&1; then
  echo "[coord-mcp] ERROR: node not on PATH"
  exit 1
fi

# Self-check the server boots.
if ! node "$SCRIPT_DIR/server.mjs" --probe >/dev/null 2>&1; then
  echo "[coord-mcp] ERROR: server --probe failed"
  exit 1
fi

# Register the stdio MCP server (user scope).
node "$SCRIPT_DIR/register-mcp.mjs" add

# Install the digest/nudge command hook (SessionStart + UserPromptSubmit), user scope.
node "$SCRIPT_DIR/install-hook.mjs"

echo "[coord-mcp] setup complete"
