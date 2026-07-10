#!/usr/bin/env bash
# autothing self-installer — idempotent.
#
# Ensures the goal-loop is wired into ~/.claude/settings.json so autothing can run
# unattended without a manual /goal:
#   * Stop hook        -> goal-stop.sh         (loops the session to completion)
#   * SessionStart hook-> goal-sessionstart.sh (session-id record + stale cleanup)
#   * env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP >= the turn cap (default 250)
#   * the two hook scripts are executable
#
# Safe to run on EVERY autothing invocation: it writes settings.json ONLY when
# something is missing/insufficient, and never duplicates an existing entry
# (dedup by the "goal-stop.sh" / "goal-sessionstart.sh" substring in the command).
#
# Exit 0 = configured (already, or just now). Exit 1 = could not configure
# (jq missing, or settings.json unwritable) — caller falls back to the printed /goal.
#
# Usage:
#   install.sh            install/repair, print what changed
#   install.sh --check    report only, exit 0 if fully configured else 3 (no writes)
set -u

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
STOP_SH="$SELF_DIR/goal-stop.sh"
SS_SH="$SELF_DIR/goal-sessionstart.sh"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
MIN_CAP="${AUTOTHING_TURN_CAP:-250}"
MODE="${1:-install}"

command -v jq >/dev/null 2>&1 || { echo "autothing-install: jq not found — cannot edit settings.json safely; add the Stop/SessionStart hooks manually or install jq." >&2; exit 1; }

is_configured() {
  # echoes "stop=<bool> ss=<bool> cap=<n|unset> disabled=<bool>"; returns 0 if all good
  [ -f "$SETTINGS" ] || { echo "stop=false ss=false cap=unset disabled=false"; return 1; }
  jq -r --argjson mincap "$MIN_CAP" '
    ([.hooks.Stop[]?.hooks[]?.command] | map(select(. != null and contains("goal-stop.sh"))) | length > 0) as $stop |
    ([.hooks.SessionStart[]?.hooks[]?.command] | map(select(. != null and contains("goal-sessionstart.sh"))) | length > 0) as $ss |
    (.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP // "unset") as $cap |
    (((.disableAllHooks // false) or (.allowManagedHooksOnly // false))) as $disabled |
    "stop=\($stop) ss=\($ss) cap=\($cap) disabled=\($disabled) ok=\($stop and $ss and (($cap|tonumber? // 0) >= $mincap))"
  ' "$SETTINGS" 2>/dev/null
}

STATUS="$(is_configured)"
OK="$(printf '%s' "$STATUS" | grep -o 'ok=true' || true)"
DISABLED="$(printf '%s' "$STATUS" | grep -o 'disabled=true' || true)"

if [ -n "$DISABLED" ]; then
  echo "autothing-install: WARNING — disableAllHooks/allowManagedHooksOnly is set; the goal-loop Stop hook will NOT fire. This run must rely on the printed /goal fallback. Unset those keys to enable auto-loop." >&2
fi

if [ "$MODE" = "--check" ]; then
  echo "autothing-install (check): ${STATUS:-unreadable}"
  [ -n "$OK" ] && exit 0 || exit 3
fi

# --- install / repair ---
chmod +x "$STOP_SH" "$SS_SH" 2>/dev/null || true
[ -f "$SETTINGS" ] || printf '%s\n' '{}' > "$SETTINGS"

tmp="$(mktemp)"
jq \
  --arg stop "bash '$STOP_SH'" \
  --arg ss "bash '$SS_SH'" \
  --argjson mincap "$MIN_CAP" '
  .env = (.env // {}) |
  .hooks = (.hooks // {}) |
  .hooks.Stop = (.hooks.Stop // []) |
  .hooks.SessionStart = (.hooks.SessionStart // []) |
  (if (((.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP // "0")|tonumber? // 0) < $mincap)
     then .env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = ($mincap|tostring) else . end) |
  (if ([.hooks.Stop[]?.hooks[]?.command] | map(select(. != null and contains("goal-stop.sh"))) | length > 0)
     then . else .hooks.Stop = ([{matcher:"*",hooks:[{type:"command",command:$stop,timeout:10}]}] + .hooks.Stop) end) |
  (if ([.hooks.SessionStart[]?.hooks[]?.command] | map(select(. != null and contains("goal-sessionstart.sh"))) | length > 0)
     then . else .hooks.SessionStart = (.hooks.SessionStart + [{matcher:"*",hooks:[{type:"command",command:$ss,timeout:10}]}]) end)
' "$SETTINGS" > "$tmp" 2>/dev/null

if [ ! -s "$tmp" ] || ! jq empty "$tmp" 2>/dev/null; then
  echo "autothing-install: jq transform failed or produced invalid JSON — settings.json left unchanged." >&2
  rm -f "$tmp"; exit 1
fi

if diff -q "$SETTINGS" "$tmp" >/dev/null 2>&1; then
  rm -f "$tmp"
  echo "autothing-install: already configured (${STATUS}). No changes."
  exit 0
fi

cp "$SETTINGS" "$SETTINGS.autothing.bak" 2>/dev/null || true
mv "$tmp" "$SETTINGS"
echo "autothing-install: installed/repaired goal-loop config -> $(is_configured). Backup: $SETTINGS.autothing.bak"
echo "autothing-install: NOTE — recent Claude Code hot-reloads hooks, so the loop may be active immediately; if your version does not, the hook is active next session. This run still proceeds and uses the printed /goal fallback if it does not auto-continue."
exit 0
