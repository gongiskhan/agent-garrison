#!/usr/bin/env bash
# Memory Fitting verify. Confirms the compiler is installed, uv is on
# PATH, the three Claude Code hooks resolve in ~/.claude/settings.json,
# and an index.md exists in the resolved output dir.
set -uo pipefail

INSTALL_DIR="${MEMORY_COMPILER_INSTALL_DIR:-$HOME/.claude/memory-compiler}"
SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"

fail() {
  echo "verify failed: $*" >&2
  exit 1
}

[ -f "$INSTALL_DIR/scripts/compile.py" ] || fail "$INSTALL_DIR/scripts/compile.py missing"
command -v uv >/dev/null 2>&1 || fail "uv not on PATH"
[ -f "$SETTINGS_FILE" ] || fail "$SETTINGS_FILE missing"

python3 - "$SETTINGS_FILE" <<'PY' || exit 1
import json
import sys
from pathlib import Path

settings = json.loads(Path(sys.argv[1]).read_text() or "{}")
hooks = settings.get("hooks", {})

required = {
    "SessionStart": "hooks/session-start.py",
    "SessionEnd": "hooks/session-end.py",
    "PreCompact": "hooks/pre-compact.py",
}

for event, marker in required.items():
    bucket = hooks.get(event, [])
    found = False
    for entry in bucket:
        for hook in entry.get("hooks", []):
            cmd = hook.get("command", "")
            if marker in cmd and "memory-compiler" in cmd:
                found = True
                break
        if found:
            break
    if not found:
        print(f"verify failed: hook for {event} not found in {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)
PY

# Resolve output dir via the same precedence the compiler uses.
if [ -n "${COMPILER_OUTPUT_DIR:-}" ]; then
  OUTPUT_DIR="$COMPILER_OUTPUT_DIR"
elif [ -d "$HOME/Projects/ekus/obsidian-vault/Compiled" ]; then
  OUTPUT_DIR="$HOME/Projects/ekus/obsidian-vault/Compiled"
elif [ -d "$HOME/dev/ekus/obsidian-vault/Compiled" ]; then
  OUTPUT_DIR="$HOME/dev/ekus/obsidian-vault/Compiled"
else
  OUTPUT_DIR="$INSTALL_DIR/knowledge"
fi

[ -f "$OUTPUT_DIR/index.md" ] || fail "$OUTPUT_DIR/index.md missing (compiler hasn't run yet?)"

echo "ok"
