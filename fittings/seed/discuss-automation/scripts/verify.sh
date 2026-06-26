#!/usr/bin/env bash
# Verify the discuss-automation skill landed in the COMPOSITION's .claude/skills
# (the place the operative actually loads from), resolved from this script's own
# path so the check is independent of cwd.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"

if [ -f "$COMPOSITION_DIR/.claude/skills/discuss-automation/SKILL.md" ]; then
  echo "ok"
  exit 0
fi
echo "discuss-automation verify: skill not installed at $COMPOSITION_DIR/.claude/skills/discuss-automation/SKILL.md" >&2
exit 1
