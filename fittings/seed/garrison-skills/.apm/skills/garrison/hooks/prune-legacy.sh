#!/usr/bin/env bash
# garrison prune-legacy — the second half of the RUN_SPEC A5 transition.
#
# install.sh is deliberately ADDITIVE: during the autothing->garrison rename both
# goal hooks may be wired at once, and the garrison Stop hook defers legacy
# sentinels to the legacy hook so a run in flight is never double-processed.
# This script is the prune that retires the legacy half once it is safe.
#
# It is GATED, not unconditional. It refuses to prune while any legacy run could
# still be looping:
#   * any file under ~/.autothing/sentinels/  -> a legacy run is armed -> REFUSE
# When the gate is clear it:
#   * removes the legacy autothing Stop + SessionStart hook entries from
#     ~/.claude/settings.json (dedup by the goal-stop.sh / goal-sessionstart.sh
#     path substring under skills/autothing/)
#   * leaves the garrison entries untouched (the garrison hook already handles
#     legacy sentinel dirs on its own once the legacy hook is gone)
#   * optionally removes the retired ~/.claude/skills/autothing/ doorway dir
#     with --remove-skill-dir (off by default: the dir is harmless once unwired)
#
# Exit 0 = pruned (or already clean). Exit 3 = refused (a legacy sentinel is
# live). Exit 1 = could not prune (jq missing / settings.json unwritable).
#
# Usage:
#   prune-legacy.sh                     prune the hook entries when safe
#   prune-legacy.sh --check             report only, no writes
#   prune-legacy.sh --remove-skill-dir  also remove ~/.claude/skills/autothing/
set -u

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
LEGACY_SENTINEL_DIR="${AUTOTHING_SENTINEL_DIR:-$HOME/.autothing/sentinels}"
LEGACY_SKILL_DIR="${AUTOTHING_SKILL_DIR:-$HOME/.claude/skills/autothing}"
CHECK_ONLY=0
REMOVE_SKILL_DIR=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --remove-skill-dir) REMOVE_SKILL_DIR=1 ;;
  esac
done

live=0
if [ -d "$LEGACY_SENTINEL_DIR" ]; then
  live="$(find "$LEGACY_SENTINEL_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
fi
if [ "$live" -gt 0 ]; then
  echo "garrison-prune: REFUSED - $live live legacy sentinel(s) in $LEGACY_SENTINEL_DIR; a legacy run may still be looping. Re-run once it ends."
  exit 3
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "garrison-prune: cannot prune - jq not found"
  exit 1
fi
if [ ! -f "$SETTINGS" ]; then
  echo "garrison-prune: nothing to prune - $SETTINGS absent"
  exit 0
fi

# Count the legacy entries (any hook command pointing at the autothing skill dir's
# goal hooks). We match on the path substring so a renamed script cannot hide.
count_legacy() {
  jq '[.hooks // {} | to_entries[] | .value[]? | .hooks[]? | select((.command // "") | test("skills/autothing/hooks/goal-(stop|sessionstart)\\.sh"))] | length' "$SETTINGS" 2>/dev/null || echo 0
}
before="$(count_legacy)"

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "garrison-prune: gate CLEAR (no live legacy sentinels); legacy hook entries present: $before"
  [ "$before" -eq 0 ] && exit 0 || exit 3
fi

if [ "$before" -eq 0 ]; then
  echo "garrison-prune: already clean - no legacy hook entries in $SETTINGS"
else
  tmp="$(mktemp)"
  # Drop the legacy hook objects, then drop any matcher group left with no hooks,
  # then drop any event left with no groups.
  jq '
    .hooks = (
      (.hooks // {})
      | with_entries(
          .value = ( .value
            | map( .hooks = ( (.hooks // []) | map(select(((.command // "") | test("skills/autothing/hooks/goal-(stop|sessionstart)\\.sh")) | not)) ) )
            | map(select((.hooks | length) > 0)) )
        )
      | with_entries(select((.value | length) > 0))
    )
  ' "$SETTINGS" > "$tmp" 2>/dev/null || { echo "garrison-prune: jq rewrite failed"; rm -f "$tmp"; exit 1; }
  if ! jq -e . "$tmp" >/dev/null 2>&1; then
    echo "garrison-prune: refusing to write invalid settings.json"; rm -f "$tmp"; exit 1
  fi
  cp "$SETTINGS" "$SETTINGS.garrison-prune.bak" 2>/dev/null || true
  mv "$tmp" "$SETTINGS" || { echo "garrison-prune: could not write $SETTINGS"; exit 1; }
  after="$(count_legacy)"
  echo "garrison-prune: removed $((before - after)) legacy hook entr(y/ies) from $SETTINGS (backup: $SETTINGS.garrison-prune.bak)"
fi

if [ "$REMOVE_SKILL_DIR" -eq 1 ] && [ -d "$LEGACY_SKILL_DIR" ]; then
  rm -rf "$LEGACY_SKILL_DIR" && echo "garrison-prune: removed the retired doorway dir $LEGACY_SKILL_DIR"
fi

echo "garrison-prune: done - the garrison goal hooks now own every sentinel dir"
exit 0
