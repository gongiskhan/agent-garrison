#!/usr/bin/env bash
# Memory Fitting setup. Clones the memory-compiler repo, runs uv sync,
# and idempotently wires SessionStart / SessionEnd / PreCompact hooks
# into ~/.claude/settings.json so Claude Code auto-captures sessions.
#
# Safe to re-run: skips clone if the install dir exists, skips sync if
# the lockfile is current, skips hook entries that already match.
set -euo pipefail

REPO_URL="${MEMORY_COMPILER_REPO_URL:-https://github.com/coleam00/claude-memory-compiler}"
INSTALL_DIR="${MEMORY_COMPILER_INSTALL_DIR:-$HOME/.claude/memory-compiler}"
SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"

log() { printf '[memory-setup] %s\n' "$*"; }

# 1. Required tools.
if ! command -v git >/dev/null 2>&1; then
  echo "git not on PATH; install git and re-run" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv not on PATH; install uv (https://docs.astral.sh/uv/) and re-run" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not on PATH; install Python 3.10+ and re-run" >&2
  exit 1
fi

# 2. Clone or skip. Treat the install as present if the expected entry
#    points exist — this covers both `git clone` checkouts and other
#    installation mechanisms (e.g. extraction from a tarball).
if [ -f "$INSTALL_DIR/scripts/compile.py" ] && [ -f "$INSTALL_DIR/hooks/session-start.py" ]; then
  log "memory-compiler already present at $INSTALL_DIR"
elif [ -e "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR exists but is missing scripts/compile.py and hooks/session-start.py; refusing to overwrite" >&2
  exit 1
else
  log "cloning $REPO_URL -> $INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

# 3. uv sync (idempotent — uv exits 0 fast if already current).
log "uv sync --directory $INSTALL_DIR"
uv sync --directory "$INSTALL_DIR" --quiet

# 4. Idempotently wire the three hooks into ~/.claude/settings.json.
mkdir -p "$(dirname "$SETTINGS_FILE")"
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

python3 - "$SETTINGS_FILE" <<'PY'
import json
import os
import sys
from pathlib import Path

settings_path = Path(sys.argv[1])
data = json.loads(settings_path.read_text() or "{}")

hooks = data.setdefault("hooks", {})

WANTED = {
    "SessionStart": {
        "command": '[ -f "$HOME/.claude/memory-compiler/hooks/session-start.py" ] && uv run --directory "$HOME/.claude/memory-compiler" python hooks/session-start.py || true',
        "timeout": 15,
    },
    "SessionEnd": {
        "command": '[ -f "$HOME/.claude/memory-compiler/hooks/session-end.py" ] && uv run --directory "$HOME/.claude/memory-compiler" python hooks/session-end.py || true',
        "timeout": 10,
    },
    "PreCompact": {
        "command": '[ -f "$HOME/.claude/memory-compiler/hooks/pre-compact.py" ] && uv run --directory "$HOME/.claude/memory-compiler" python hooks/pre-compact.py || true',
        "timeout": 10,
    },
}

added = []
for event, spec in WANTED.items():
    bucket = hooks.setdefault(event, [])
    found = False
    for entry in bucket:
        for hook in entry.get("hooks", []):
            if hook.get("command") == spec["command"]:
                found = True
                break
        if found:
            break
    if found:
        continue
    bucket.append({
        "matcher": "",
        "hooks": [{
            "command": spec["command"],
            "timeout": spec["timeout"],
            "type": "command",
        }],
    })
    added.append(event)

settings_path.write_text(json.dumps(data, indent=2) + "\n")
if added:
    print(f"[memory-setup] wired hooks: {', '.join(added)}")
else:
    print("[memory-setup] hooks already wired")
PY

# 5. Resolve COMPILER_OUTPUT_DIR for visibility (the compiler resolves it
#    at runtime, so we don't write anything — just print where output goes).
if [ -n "${COMPILER_OUTPUT_DIR:-}" ]; then
  log "COMPILER_OUTPUT_DIR=${COMPILER_OUTPUT_DIR} (env override)"
elif [ -d "$HOME/Projects/ekus/obsidian-vault/Compiled" ]; then
  log "output dir: \$HOME/Projects/ekus/obsidian-vault/Compiled (canonical vault)"
elif [ -d "$HOME/dev/ekus/obsidian-vault/Compiled" ]; then
  log "output dir: \$HOME/dev/ekus/obsidian-vault/Compiled (canonical vault)"
else
  log "output dir: $INSTALL_DIR/knowledge (legacy fallback; vault not found)"
fi

log "memory setup ok"
