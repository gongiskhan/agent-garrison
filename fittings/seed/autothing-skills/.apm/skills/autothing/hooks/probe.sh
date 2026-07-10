#!/usr/bin/env bash
# autothing goal-loop LIVENESS PROBE.
#
# Confirms that Claude Code actually honors the goal-loop Stop hook in THIS session
# (i.e. that `decision:block` from goal-stop.sh really auto-continues the turn with
# NO /goal). It exercises the real goal-stop.sh — not a mock.
#
# Procedure:
#   1) bash probe.sh arm     # arms a tiny probe sentinel (cap 2) for this session
#   2) end your turn         # if the hook is LIVE, the session auto-continues
#   3) bash probe.sh check   # reports LIVE (iteration incremented) or NOT LIVE
#
#   - If the session auto-continues after step 2, the hook is live; goal-stop.sh
#     injects a "GOAL-LOOP LIVENESS PROBE … run probe.sh check" instruction.
#   - If it just stops, the hook is not active this session — send any message and
#     run `probe.sh check`; iteration will be 0.
#
# Self-bounded: cap=2, so even with no `check` the probe releases after 2 blocks.
# Run this in a session that is NOT executing an autothing build (it shares the
# per-session sentinel path); it refuses to clobber a live (non-probe) sentinel.
set -u
SID="${CLAUDE_CODE_SESSION_ID:-}"
DIR="$HOME/.autothing/sentinels"
SENT="$DIR/$SID.json"
now() { date -u +%FT%TZ 2>/dev/null || echo "now"; }

case "${1:-}" in
  arm)
    [ -n "$SID" ] || { echo "probe: CLAUDE_CODE_SESSION_ID not set — can't key the sentinel"; exit 1; }
    command -v jq >/dev/null 2>&1 || { echo "probe: jq required"; exit 1; }
    mkdir -p "$DIR"
    if [ -f "$SENT" ] && [ "$(jq -r '.probe // false' "$SENT" 2>/dev/null)" != "true" ]; then
      echo "probe: a non-probe sentinel is already armed for this session (likely a live autothing run)."
      echo "       Run the probe in a SEPARATE session so it doesn't clobber that run. Aborting."
      exit 1
    fi
    jq -n --arg at "$(now)" '{runId:"hook-probe", probe:true, turnCap:2, iteration:0, armedAt:$at, condition:"goal-loop liveness probe"}' > "$SENT"
    echo "PROBE ARMED for session ${SID} (cap 2)."
    echo "NEXT: end your turn now. If the goal-loop hook is LIVE, the session auto-continues"
    echo "and you'll be told to run:  bash ~/.claude/skills/autothing/hooks/probe.sh check"
    echo "If the turn just ends (no auto-continue), the hook is NOT active this session —"
    echo "send any message, then run the same check (it will report NOT LIVE)."
    ;;
  check)
    [ -n "$SID" ] || { echo "probe: CLAUDE_CODE_SESSION_ID not set"; exit 1; }
    if [ ! -f "$SENT" ]; then echo "PROBE: no probe sentinel found (already cleared, or never armed in this session)."; exit 0; fi
    IT="$(jq -r '.iteration // 0' "$SENT" 2>/dev/null)"
    ISPROBE="$(jq -r '.probe // false' "$SENT" 2>/dev/null)"
    if [ "$ISPROBE" != "true" ]; then echo "PROBE: the current sentinel is NOT a probe (a real run is armed) — not touching it."; exit 0; fi
    rm -f "$SENT" 2>/dev/null
    if [ "${IT:-0}" -ge 1 ] 2>/dev/null; then
      echo "PROBE RESULT: HOOK LIVE ✓ — the goal-loop Stop hook fired and auto-continued the session (iteration=${IT}). No /goal needed for real runs in sessions like this. Probe sentinel cleared."
    else
      echo "PROBE RESULT: HOOK NOT LIVE ✗ — iteration=0, so the Stop hook did not block/continue this session."
      echo "  Likely cause: the hook was added mid-session (it activates only at the NEXT session start), or hooks are disabled."
      echo "  Fix: ensure goal-stop.sh is registered in settings.json (bash ~/.claude/skills/autothing/hooks/install.sh --check), then start a FRESH session and re-probe. Probe sentinel cleared."
    fi
    ;;
  clear)
    if [ -f "$SENT" ] && [ "$(jq -r '.probe // false' "$SENT" 2>/dev/null)" = "true" ]; then rm -f "$SENT"; echo "probe sentinel cleared."; else echo "no probe sentinel to clear."; fi
    ;;
  *)
    echo "usage: probe.sh arm | check | clear   (run arm, end your turn, then check)";;
esac
