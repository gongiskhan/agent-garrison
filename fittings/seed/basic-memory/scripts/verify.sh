#!/usr/bin/env bash
# Basic Memory Fitting verify. Confirms Basic Memory is installed, the vault
# project is registered and present, the backend's ops surface is actually in
# place (the MCP server on `local`, the remote-CLI skill variant otherwise), and
# (when enabled) the capture hook is wired into settings.json.
#
# Read-only, and it must pass UNCONFIGURED - the default local backend needs no
# account, no key and no network. It never reads or prints a credential.
set -uo pipefail

VAULT_DIR="${BASIC_MEMORY_VAULT_DIR:-$HOME/ObsidianVault}"
VAULT_DIR="${VAULT_DIR/#\~/$HOME}"
PROJECT_NAME="${BASIC_MEMORY_PROJECT_NAME:-main}"
CAPTURE_ENABLED="${BASIC_MEMORY_CAPTURE_ENABLED:-true}"
CLAUDE_HOME="${GARRISON_CLAUDE_HOME:-$HOME/.claude}"
SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-${GARRISON_CLAUDE_SETTINGS_PATH:-$CLAUDE_HOME/settings.json}}"
CONFIG_DIR="${BASIC_MEMORY_CONFIG_DIR:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/basic-memory}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSITION_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MODULES_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKILL_DEST="$COMPOSITION_DIR/.claude/skills/garrison-memory/SKILL.md"
SKILL_STATE_FILE="$COMPOSITION_DIR/.garrison/basic-memory-skill-backend"
# Full-line, fixed-string. Used only to ATTEST that the deployed file is the
# remote variant - never to decide the backend, and never as a substring match:
# an unanchored grep would read a skill that merely quotes the marker as proof.
SKILL_REMOTE_MARK="<!-- garrison-memory-backend: cortex -->"

# Which backend to verify against. `runner.verify()` projects only the gateway
# env into verify hooks - NOT the fitting's config (unlike setup, which gets
# setupConfigEnv) - so BASIC_MEMORY_BACKEND is normally absent here and the
# backend is read from the SIDECAR setup.sh wrote, not from the payload. Keying
# on the payload would make verify's own verdict depend on the content of a file
# APM owns and rewrites. An explicitly set BASIC_MEMORY_BACKEND (a manual run, a
# test) wins, so intent can still be asserted against reality. Unknown values
# read as the shipped default.
BACKEND="$(printf '%s' "${BASIC_MEMORY_BACKEND:-}" | tr '[:upper:]' '[:lower:]')"
if [ -z "$BACKEND" ] && [ -f "$SKILL_STATE_FILE" ]; then
  BACKEND="$(tr -d '[:space:]' < "$SKILL_STATE_FILE" | tr '[:upper:]' '[:lower:]')"
fi
[ "$BACKEND" = "cortex" ] || BACKEND="local"

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
  local cfg="${BASIC_MEMORY_CONFIG:-${CONFIG_DIR:-${BASIC_MEMORY_HOME:-$HOME/.basic-memory}}/config.json}"
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

if [ "$BACKEND" = "local" ]; then
  if command -v claude >/dev/null 2>&1; then
    claude mcp get basic-memory >/dev/null 2>&1 || fail "basic-memory MCP not registered with Claude Code"
  fi
else
  # Remote backend: the local MCP server must be gone (two memories, no way to
  # tell which is authoritative, is the failure this catches) and the operative
  # must have been handed the remote-CLI skill variant.
  if command -v claude >/dev/null 2>&1 && claude mcp get basic-memory >/dev/null 2>&1; then
    fail "backend=$BACKEND but the basic-memory MCP server is still registered with Claude Code"
  fi
  if [ "$(basename "$MODULES_DIR")" = "apm_modules" ]; then
    [ -f "$SKILL_DEST" ] || fail "backend=$BACKEND but $SKILL_DEST is missing"
    # -x (whole line) -F (fixed string): a skill that merely quotes the marker
    # inline or in a fenced block is not the remote variant and must not pass.
    grep -qxF "$SKILL_REMOTE_MARK" "$SKILL_DEST" 2>/dev/null \
      || fail "backend=$BACKEND but $SKILL_DEST is not the remote skill variant"
  fi
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
