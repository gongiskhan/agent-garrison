#!/usr/bin/env bash
# Nightly one-way evidence backup: plans + evidence from every peer node into
# this node's sink. Runs on dev-madrid (the sink), PULLING over ssh — one
# place runs it, no peer needs write access here.
#
#   mesh-evidence-backup.sh <ssh-target> <node-name> [--dry-run]
#
# Three source roots per node (walkthrough videos live OUTSIDE ~/.garrison):
#   ~/.garrison/{runs,results}   and   ~/.walkthrough/runs
# IN:  runs/**/{FLOW_PLAN.md,DECISIONS.md,gate-status.*,duty-summary.*,evidence/**}
#      results/**   walkthrough final.mp4+manifest+storyboard
# OUT: session-logs, drill/live, capture, **/work/**, frames/
#
# rsync's include/exclude chain is FIRST-MATCH-WINS IN FLAG ORDER — the
# include set below was pinned with --dry-run against a real tree before it
# shipped; edit it only with another --dry-run in hand.
# The 7-day prune runs ON THE SINK ONLY. Peers' artifacts are never touched.
set -euo pipefail

TARGET="${1:?usage: mesh-evidence-backup.sh <ssh-target> <node-name> [--dry-run]}"
NODE="${2:?node name required}"
[[ "$NODE" =~ ^[a-z][a-z0-9-]{1,63}$ ]] || { echo "invalid node name" >&2; exit 2; }
DRY=()
for arg in "$@"; do [ "$arg" = "--dry-run" ] && DRY=(--dry-run -v); done

SINK="${GARRISON_HOME:-$HOME/.garrison}/mesh-evidence/$NODE"
CONVERSATIONS_SINK="${GARRISON_HOME:-$HOME/.garrison}/mesh-conversations/$NODE"
SOURCE="${RSYNC_TARGET_OVERRIDE:-$TARGET:}"
if [ -n "${RSYNC_TARGET_OVERRIDE:-}" ]; then SOURCE="${RSYNC_TARGET_OVERRIDE%/}/"; fi
mkdir -p "$SINK/garrison" "$SINK/walkthrough"

# Root 1: ~/.garrison — runs/ (plans, decisions, gates, evidence) + results/
rsync -a "${DRY[@]}" --prune-empty-dirs \
  --include='runs/' \
  --include='runs/**/' \
  --include='runs/**/FLOW_PLAN.md' \
  --include='runs/**/DECISIONS.md' \
  --include='runs/**/gate-status.*' \
  --include='runs/**/duty-summary.*' \
  --include='runs/**/touch-set.json' \
  --include='runs/**/evidence/**' \
  --include='results/' \
  --include='results/**' \
  --exclude='results/**/media/**/*.webm.part' \
  --exclude='**/work/**' \
  --exclude='*' \
  -e "ssh -o BatchMode=yes" \
  "${SOURCE}.garrison/" "$SINK/garrison/" 2>/dev/null \
  || echo "[evidence-backup] $NODE: ~/.garrison pull incomplete (dir may not exist yet)"

# Root 2: ~/.walkthrough/runs — the finished artifacts, never the work dirs.
rsync -a "${DRY[@]}" --prune-empty-dirs \
  --include='*/' \
  --include='final.mp4' \
  --include='manifest.json' \
  --include='storyboard.json' \
  --exclude='frames/**' \
  --exclude='work/**' \
  --exclude='*' \
  -e "ssh -o BatchMode=yes" \
  "${SOURCE}.walkthrough/runs/" "$SINK/walkthrough/" 2>/dev/null \
  || echo "[evidence-backup] $NODE: ~/.walkthrough pull skipped (absent is normal)"

# Conversation ledgers have no rolling prune. A failed pull must fail the job:
# a silently stale conversation backup cannot satisfy the restore drill.
mkdir -p "$CONVERSATIONS_SINK"
if rsync -a "${DRY[@]}" --exclude='**/work/**' --exclude='*.part' \
  -e "ssh -o BatchMode=yes" \
  "${SOURCE}.garrison/conversations/" "$CONVERSATIONS_SINK/"; then
  :
else
  rc=$?
  # A node that has never run a Conversation has no source directory. Prove
  # that absence separately; connection/permission/partial-copy failures must
  # still fail the scheduled job rather than disguising a stale backup.
  absent=1
  if [ -n "${RSYNC_TARGET_OVERRIDE:-}" ]; then
    [ -d "${SOURCE}.garrison" ] && [ ! -e "${SOURCE}.garrison/conversations" ] && absent=0
  elif ssh -o BatchMode=yes "$TARGET" 'test -r "$HOME/.garrison" && test -d "$HOME/.garrison" && test ! -e "$HOME/.garrison/conversations"'; then
    absent=0
  fi
  if [ "$absent" = "0" ]; then
    echo "[evidence-backup] $NODE: no conversations directory; previous backup retained"
  else
    exit "$rc"
  fi
fi

# Sink-side rolling prune applies ONLY to evidence; dry-run never prunes.
if [ "${#DRY[@]}" -eq 0 ]; then
  find "$SINK" -type f -mtime +7 -delete 2>/dev/null || true
  find "$SINK" -type d -empty -delete 2>/dev/null || true
fi

echo "[evidence-backup] $NODE -> $SINK ($(du -sh "$SINK" 2>/dev/null | cut -f1))"
