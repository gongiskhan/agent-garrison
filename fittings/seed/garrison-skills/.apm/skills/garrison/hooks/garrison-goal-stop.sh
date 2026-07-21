#!/usr/bin/env bash
# garrison goal-loop Stop hook  (reproduces /goal, deterministically) — PER SESSION
#
# type:"command" Stop hook. NO model call, NO `claude -p`, NO Agent SDK.
# Blocks the stop (forcing another turn) while THIS session has an armed garrison
# run that has NOT yet printed its terminal `GLOBAL GATE:` verdict.
#
# TRANSITION SAFETY (autothing->garrison rename, RUN_SPEC A5). This hook honors BOTH
# sentinel homes and BOTH verdict grammars:
#   * new runs arm under ~/.garrison/sentinels/<session_id>.json
#   * legacy in-flight runs live under ~/.autothing/sentinels/<session_id>.json
# While the LEGACY autothing Stop hook (.../autothing/hooks/goal-stop.sh) is still
# wired in settings.json, this hook DEFERS any legacy (~/.autothing) sentinel to it
# so an in-flight legacy run is never double-incremented. Once the legacy entry is
# pruned (last rename step, gated on no live legacy sentinel), this hook alone
# handles both homes. The GLOBAL GATE grammar is era-neutral so it matches both.
#
# Per-session sentinel: <home>/sentinels/<session_id>.json. Each concurrent session
# has its OWN sentinel, so parallel runs never clobber each other. Phase 0 writes it
# keyed by $CLAUDE_CODE_SESSION_ID; this hook reads it keyed by the Stop event's
# session_id (the same id) — no cross-session interference is possible.
#
# Termination (any -> allow the stop, exit 0):
#   * no session id / no sentinel for this session  -> not our run
#   * transcript has the terminal GLOBAL GATE line   -> done (delete sentinel)
#   * iteration >= turnCap                            -> turn-budget backstop (surface)
# Otherwise -> increment + emit {"decision":"block", ...} to take another turn.
#
# FAIL SAFE: any error/ambiguity -> exit 0 (ALLOW the stop). A wrong block is a
# runaway; allowing the stop is the safe failure. CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
# (raised in settings.json) is the platform backstop behind this hook.
set -u

INPUT="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0

SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$SESSION_ID" ] || exit 0

GARRISON_SENT="${HOME}/.garrison/sentinels/${SESSION_ID}.json"
LEGACY_SENT="${HOME}/.autothing/sentinels/${SESSION_ID}.json"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

# Resolve which sentinel to act on. Prefer the garrison home (new runs). Fall back
# to the legacy home ONLY when the legacy autothing Stop hook is not (any longer)
# wired — otherwise defer to it, so a live legacy run is not double-processed.
SENTINEL=""
if [ -f "$GARRISON_SENT" ]; then
  SENTINEL="$GARRISON_SENT"
elif [ -f "$LEGACY_SENT" ]; then
  legacy_wired=0
  if [ -f "$SETTINGS" ] && jq -e '
      [.hooks.Stop[]?.hooks[]?.command]
      | map(select(. != null and (contains("goal-stop.sh") and (contains("garrison-goal-stop.sh")|not))))
      | length > 0' "$SETTINGS" >/dev/null 2>&1; then
    legacy_wired=1
  fi
  [ "$legacy_wired" -eq 1 ] && exit 0
  SENTINEL="$LEGACY_SENT"
fi
[ -n "$SENTINEL" ] || exit 0

TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"
STOP_ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)"
RUN_ID="$(jq -r '.runId // "unknown"' "$SENTINEL" 2>/dev/null)"
TURN_CAP="$(jq -r '.turnCap // 250' "$SENTINEL" 2>/dev/null)"
ITER="$(jq -r '.iteration // 0' "$SENTINEL" 2>/dev/null)"
PROBE="$(jq -r '.probe // false' "$SENTINEL" 2>/dev/null)"

# DONE: THIS run's terminal GLOBAL GATE verdict is in the transcript.
# Bound to the run's unique runId AND the videos:<n>/<n> metric signature, so NONE of
# these can falsely release the loop: the QUOTED "GLOBAL GATE: passed" /goal target
# (no videos:N/N); a stray/example/quoted verdict line; a verdict from a DIFFERENT or
# prior run (different runId); or a dev session discussing the format. A liveness probe
# (probe:true) has no real verdict, so it skips this check entirely. The grammar is
# era-neutral (GLOBAL GATE + runId + videos:N/N) — it matches both the autothing and
# garrison terminal verdict lines.
if [ "$PROBE" != "true" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] \
   && [ -n "$RUN_ID" ] && [ "$RUN_ID" != "unknown" ] \
   && grep -Eq "GLOBAL GATE:.*${RUN_ID}.*videos:[0-9]+/[0-9]+" "$TRANSCRIPT" 2>/dev/null; then
  rm -f "$SENTINEL" 2>/dev/null
  exit 0
fi

# Turn-budget backstop (mirrors /goal's "Stop after N turns"): release the session.
if [ "${ITER:-0}" -ge "${TURN_CAP:-250}" ] 2>/dev/null; then
  echo "garrison goal-loop: run ${RUN_ID} reached its turn cap (${TURN_CAP}) without a terminal GLOBAL GATE line — releasing the session. Surface this as a loop failure, not a clean completion." 1>&2
  exit 0
fi

# Not done, budget remains -> block the stop and force another turn.
NEXT=$(( ${ITER:-0} + 1 ))
tmp="$(mktemp)" && jq --argjson n "$NEXT" '.iteration=$n' "$SENTINEL" >"$tmp" 2>/dev/null && mv "$tmp" "$SENTINEL" || rm -f "$tmp" 2>/dev/null

# stop_hook_active is logged only — NOT a terminator (a /goal-style loop legitimately
# stays in forced-continuation for many turns; the terminators above end it).
if [ "$PROBE" = "true" ]; then
  # Liveness-probe sentinel: the fact this block is honored proves the hook is live.
  reason="GOAL-LOOP LIVENESS PROBE — the Stop hook fired and is auto-continuing this session (iteration ${NEXT}/${TURN_CAP}). The hook is LIVE. Confirm + clear with: bash ~/.claude/skills/garrison/hooks/probe.sh check"
else
  reason="[goal-loop] holding session open - this is the loop working, not an error: garrison run ${RUN_ID} has not printed its terminal GLOBAL GATE line (iteration ${NEXT}/${TURN_CAP}, stop_hook_active=${STOP_ACTIVE}); buildable work may remain - resume the per-slice loop from this run's FLOW_PLAN + gate-status + evidence-index files and continue to the next buildable slice."
fi
jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
