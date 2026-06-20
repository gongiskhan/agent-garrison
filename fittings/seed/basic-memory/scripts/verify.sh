#!/usr/bin/env bash
# Basic Memory Fitting verify. Confirms Basic Memory is installed, the vault
# project is registered and present, the MCP server is registered with Claude
# Code, and (when enabled) the capture hook is wired into settings.json.
set -uo pipefail

VAULT_DIR="${BASIC_MEMORY_VAULT_DIR:-$HOME/ObsidianVault}"
VAULT_DIR="${VAULT_DIR/#\~/$HOME}"
PROJECT_NAME="${BASIC_MEMORY_PROJECT_NAME:-main}"
CAPTURE_ENABLED="${BASIC_MEMORY_CAPTURE_ENABLED:-true}"
SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"

export PATH="$HOME/.local/bin:$PATH"
fail() { echo "verify failed: $*" >&2; exit 1; }

command -v basic-memory >/dev/null 2>&1 || fail "basic-memory not on PATH"
[ -d "$VAULT_DIR" ] || fail "vault dir $VAULT_DIR missing"
basic-memory project list 2>/dev/null | grep -q "[[:space:]]$PROJECT_NAME[[:space:]]" || fail "project '$PROJECT_NAME' not registered"

if command -v claude >/dev/null 2>&1; then
  claude mcp get basic-memory >/dev/null 2>&1 || fail "basic-memory MCP not registered with Claude Code"
fi

if [ "$CAPTURE_ENABLED" = "true" ]; then
  [ -f "$SETTINGS_FILE" ] || fail "$SETTINGS_FILE missing"
  python3 - "$SETTINGS_FILE" <<'PY' || exit 1
import json, sys
from pathlib import Path
hooks = json.loads(Path(sys.argv[1]).read_text() or "{}").get("hooks", {})
for event in ("SessionEnd", "PreCompact"):
    ok = any("basic-memory/capture-session.py" in h.get("command","")
             for e in hooks.get(event, []) for h in e.get("hooks", []))
    if not ok:
        print(f"verify failed: capture hook for {event} not wired", file=sys.stderr)
        sys.exit(1)
PY
fi

echo "ok"
