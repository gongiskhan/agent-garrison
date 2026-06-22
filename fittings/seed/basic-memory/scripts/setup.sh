#!/usr/bin/env bash
# Basic Memory Fitting setup. Installs Basic Memory, registers the vault as a
# project, wires the basic-memory MCP server into Claude Code (and optionally
# Codex + Gemini), installs the lightweight session-capture hook to a stable
# location, and idempotently wires SessionEnd / PreCompact into
# ~/.claude/settings.json.
#
# Safe to re-run: every step checks current state before changing it.
set -euo pipefail

VAULT_DIR="${BASIC_MEMORY_VAULT_DIR:-$HOME/ObsidianVault}"
VAULT_DIR="${VAULT_DIR/#\~/$HOME}"
MEMORY_DIR="${BASIC_MEMORY_MEMORY_DIR:-Memory}"
PROJECT_NAME="${BASIC_MEMORY_PROJECT_NAME:-main}"
CAPTURE_ENABLED="${BASIC_MEMORY_CAPTURE_ENABLED:-true}"
REGISTER_CG="${BASIC_MEMORY_REGISTER_CODEX_GEMINI:-true}"
SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"
HOOK_HOME="$HOME/.claude/basic-memory"
HOOK_PATH="$HOOK_HOME/capture-session.py"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PATH="$HOME/.local/bin:$PATH"
log() { printf '[basic-memory-setup] %s\n' "$*"; }

# 1. Required tools.
command -v uv >/dev/null 2>&1 || { echo "uv not on PATH; install uv (https://docs.astral.sh/uv/) and re-run" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not on PATH; install Python 3.10+ and re-run" >&2; exit 1; }

# 2. Install Basic Memory (idempotent — uv tool install is a no-op if current).
if command -v basic-memory >/dev/null 2>&1; then
  log "basic-memory present: $(basic-memory --version 2>/dev/null || echo '?')"
else
  log "installing basic-memory via uv tool install"
  uv tool install basic-memory
fi
BM="$(command -v basic-memory)"

# 3. Register the vault as the Basic Memory project (idempotent).
mkdir -p "$VAULT_DIR/$MEMORY_DIR"
CURRENT_PATH="$("$BM" project list 2>/dev/null | awk -v p="$PROJECT_NAME" '$0 ~ p {print}' | grep -o "$VAULT_DIR" || true)"
if "$BM" project list 2>/dev/null | grep -q "[[:space:]]$PROJECT_NAME[[:space:]]"; then
  # project exists — ensure it points at the vault
  if [ "$CURRENT_PATH" != "$VAULT_DIR" ]; then
    log "re-pointing project '$PROJECT_NAME' -> $VAULT_DIR"
    "$BM" project move "$PROJECT_NAME" "$VAULT_DIR" >/dev/null 2>&1 || true
  else
    log "project '$PROJECT_NAME' already -> $VAULT_DIR"
  fi
else
  log "adding project '$PROJECT_NAME' -> $VAULT_DIR"
  "$BM" project add "$PROJECT_NAME" "$VAULT_DIR" >/dev/null 2>&1 || \
    "$BM" project move "$PROJECT_NAME" "$VAULT_DIR" >/dev/null 2>&1 || true
fi
"$BM" project default "$PROJECT_NAME" >/dev/null 2>&1 || true

# 4. Register the MCP server with Claude Code (user scope, idempotent).
if command -v claude >/dev/null 2>&1; then
  if claude mcp get basic-memory >/dev/null 2>&1; then
    log "claude mcp 'basic-memory' already registered"
  else
    log "registering basic-memory MCP with Claude Code"
    claude mcp add -s user basic-memory -- "$BM" mcp >/dev/null 2>&1 || true
  fi
else
  log "claude CLI not on PATH; skipping Claude MCP registration"
fi

# 5. Register the MCP server with Codex + Gemini (idempotent, soft-fail).
if [ "$REGISTER_CG" = "true" ]; then
  if command -v codex >/dev/null 2>&1; then
    if codex mcp get basic-memory >/dev/null 2>&1; then
      log "codex mcp 'basic-memory' already registered"
    else
      log "registering basic-memory MCP with Codex"
      codex mcp add basic-memory -- "$BM" mcp >/dev/null 2>&1 || log "codex mcp add failed (non-fatal)"
    fi
  fi
  if command -v gemini >/dev/null 2>&1; then
    if gemini mcp list 2>/dev/null | grep -q basic-memory; then
      log "gemini mcp 'basic-memory' already registered"
    else
      log "registering basic-memory MCP with Gemini"
      gemini mcp add -s user basic-memory "$BM" mcp >/dev/null 2>&1 || log "gemini mcp add failed (non-fatal)"
    fi
  fi
fi

# 6. Install the capture hook to a stable location + wire it (idempotent).
if [ "$CAPTURE_ENABLED" = "true" ]; then
  mkdir -p "$HOOK_HOME"
  cp "$SCRIPT_DIR/capture-session.py" "$HOOK_PATH"
  chmod +x "$HOOK_PATH"

  mkdir -p "$(dirname "$SETTINGS_FILE")"
  [ -f "$SETTINGS_FILE" ] || echo '{}' > "$SETTINGS_FILE"

  CAP_CMD="BASIC_MEMORY_VAULT_DIR=\"$VAULT_DIR\" BASIC_MEMORY_MEMORY_DIR=\"$MEMORY_DIR\" python3 \"$HOOK_PATH\""
  python3 - "$SETTINGS_FILE" "$CAP_CMD" <<'PY'
import json, sys
from pathlib import Path
sp = Path(sys.argv[1]); cmd = sys.argv[2]
data = json.loads(sp.read_text() or "{}")
hooks = data.setdefault("hooks", {})
added = []
for event in ("SessionEnd", "PreCompact"):
    bucket = hooks.setdefault(event, [])
    if any("basic-memory/capture-session.py" in h.get("command","")
           for e in bucket for h in e.get("hooks", [])):
        continue
    bucket.append({"matcher": "", "hooks": [{"type": "command", "command": cmd, "timeout": 10}]})
    added.append(event)
sp.write_text(json.dumps(data, indent=2) + "\n")
print("[basic-memory-setup] capture hook wired: " + (", ".join(added) if added else "already wired"))
PY
else
  log "capture hook disabled (capture_enabled=false)"
fi

log "basic-memory setup ok"
