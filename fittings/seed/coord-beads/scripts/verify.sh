#!/usr/bin/env bash
# coord-beads verify (read-only) — bd present AND the owner-tagged SessionStart
# hook is installed. Prints "ok" on success (matches apm.yml verify.expect).
#
# Honors GARRISON_CLAUDE_SETTINGS_PATH (sandbox).
set -uo pipefail

OWNER="fitting:coord-beads"
SETTINGS_PATH="${GARRISON_CLAUDE_SETTINGS_PATH:-$HOME/.claude/settings.json}"

if ! command -v bd >/dev/null 2>&1; then
  echo "verify-failed: bd not on PATH"
  exit 1
fi

if [ ! -f "$SETTINGS_PATH" ]; then
  echo "verify-failed: no settings.json at $SETTINGS_PATH"
  exit 1
fi

# Confirm an owner-tagged coord-beads group exists under SessionStart.
if ! node -e '
  const fs = require("node:fs");
  const p = process.argv[1], owner = process.argv[2];
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  const groups = (s.hooks && s.hooks.SessionStart) || [];
  const found = Array.isArray(groups) && groups.some((g) => g && g._garrison === owner);
  process.exit(found ? 0 : 1);
' "$SETTINGS_PATH" "$OWNER"; then
  echo "verify-failed: no $OWNER SessionStart hook in $SETTINGS_PATH"
  exit 1
fi

echo "ok"
