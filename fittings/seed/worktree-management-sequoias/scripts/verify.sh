#!/usr/bin/env bash
# Strict verify: git worktree subcommand is available AND Garrison's hooks
# are installed (marker `_garrison` present in ~/.claude/settings.json). A
# missing marker means session-view badges would never update from this
# worktree, so report it as failure rather than silently passing.
set -euo pipefail
git worktree list >/dev/null 2>&1
if ! grep -q '"_garrison"' "$HOME/.claude/settings.json" 2>/dev/null; then
  echo "FAIL: garrison hook marker not found in ~/.claude/settings.json" >&2
  echo "      Re-run this Fitting's setup with Garrison running." >&2
  exit 1
fi
echo "ok"
