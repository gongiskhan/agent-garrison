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

# Project-existence check that is ROBUST against Rich's table rendering. `basic-memory
# project list` prints a Rich table whose Name column COLLAPSES when stdout is not a TTY
# (the runner pipes it), so grepping the list gave a false "not registered" even though
# the project is registered. Primary: `project info <name>` exits 0 iff the project
# resolves. Fallback (older basic-memory without `project info`): an EXACT key lookup in
# the config registry (the source of truth) — not the Rich table, and not a regex, so a
# project name containing metacharacters or that is a prefix of another never false-matches.
project_registered() {
  basic-memory project info "$PROJECT_NAME" >/dev/null 2>&1 && return 0
  local cfg="${BASIC_MEMORY_CONFIG:-${BASIC_MEMORY_HOME:-$HOME/.basic-memory}/config.json}"
  [ -f "$cfg" ] || return 1
  PROJECT_NAME="$PROJECT_NAME" python3 - "$cfg" <<'PY'
import json, os, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if os.environ["PROJECT_NAME"] in (cfg.get("projects") or {}) else 1)
PY
}
project_registered || fail "project '$PROJECT_NAME' not registered"

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
