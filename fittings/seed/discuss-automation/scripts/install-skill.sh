#!/usr/bin/env bash
# Install the discuss-automation skill into the COMPOSITION's .claude/skills so
# the operative can load it. Resolves the composition dir from this script's own
# path (works regardless of cwd) — never a cwd-relative .claude.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"
dest="$COMPOSITION_DIR/.claude/skills/discuss-automation"

mkdir -p "$dest"
cp -f "$FITTING_DIR/.apm/skills/discuss-automation/SKILL.md" "$dest/SKILL.md"
echo "ok"
