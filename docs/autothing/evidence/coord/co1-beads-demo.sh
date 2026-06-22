#!/usr/bin/env bash
# CO1 evidence — coord-beads: user-scope SessionStart hook install, fresh-repo
# fail-open safety, and clean removal. Runs entirely against a SANDBOX settings
# file (never the live ~/.claude).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 1   # repo root
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; sleep 0.6; }

SB=$(mktemp -d /tmp/co1-demo.XXXX)
export GARRISON_CLAUDE_SETTINGS_PATH="$SB/settings.json" GARRISON_HOME="$SB"

say "coord-beads — Beads coordination Fitting (pin v1.0.5, pure MIT)"
bd version 2>/dev/null || bd --version; sleep 0.4

say "1. Select the Fitting -> setup installs an owner-tagged user-scope SessionStart hook"
bash fittings/seed/coord-beads/scripts/setup.sh
sleep 0.4
echo "--- the installed hook (owner-tagged, fail-open) ---"
node -e 'console.log(JSON.stringify(require(process.argv[1]).hooks.SessionStart,null,2))' "$SB/settings.json"
sleep 0.8

say "2. verify -> ok"
bash fittings/seed/coord-beads/scripts/verify.sh; sleep 0.6

say "3. Fresh-repo safety: the hook command is a quiet no-op when there is no .beads graph"
FRESH=$(mktemp -d /tmp/co1-demo-fresh.XXXX); ( cd "$FRESH" && git init -q )
( cd "$FRESH" && sh -c 'command -v bd >/dev/null 2>&1 && bd prime --hook-json 2>/dev/null || true' )
echo "   ^ empty additionalContext, exit 0 -> never errors, never blocks"
sleep 0.8

say "4. Deselect -> clean+complete removal of ONLY the owner group"
node fittings/seed/coord-beads/scripts/uninstall-hooks.mjs
echo "--- settings after removal (no orphan) ---"
cat "$SB/settings.json"; echo
sleep 0.6

say "BEADS-FITTING OK"
rm -rf "$SB" "$FRESH"
