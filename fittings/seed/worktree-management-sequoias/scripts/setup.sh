#!/usr/bin/env bash
# Wire Garrison's Claude Code hooks into ~/.claude/settings.json so worktree
# session statuses reflect live Claude Code activity.
#
# The Garrison dev server must already be running (it is — the runner invokes
# setup AFTER `npm start` has booted next dev). The install endpoint derives
# its own hook URL from the request origin.
set -euo pipefail

# Verify git is available (required for worktree management).
git --version >/dev/null
echo "git available"

GARRISON_URL="${GARRISON_URL:-http://127.0.0.1:3000}"
RESPONSE=$(curl -fsS -X POST "$GARRISON_URL/api/workbench/sessions/install-hooks" \
  -H 'Content-Type: application/json' \
  -d '{}') || {
  echo "FAIL: hook install against $GARRISON_URL did not succeed." >&2
  echo "      Make sure Garrison is running on that URL, then re-run setup." >&2
  echo "      Set GARRISON_URL in the environment to point at a different origin." >&2
  exit 1
}
echo "claude-hooks: $RESPONSE"
