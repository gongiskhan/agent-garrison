#!/usr/bin/env bash
# Nightly one-way evidence backup: plans + evidence from every peer node into
# this node's sink. Runs on dev-madrid (the sink), PULLING over ssh — one
# place runs it, no peer needs write access here.
#
#   mesh-evidence-backup.sh <ssh-target> <node-name> [--dry-run]
#
# TWO source roots per node (walkthrough videos live OUTSIDE ~/.garrison):
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
DRY=""
[ "${3:-}" = "--dry-run" ] && DRY="--dry-run -v"

SINK="$HOME/.garrison/mesh-evidence/$NODE"
mkdir -p "$SINK/garrison" "$SINK/walkthrough"

# Root 1: ~/.garrison — runs/ (plans, decisions, gates, evidence) + results/
rsync -a $DRY --prune-empty-dirs \
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
  "$TARGET:.garrison/" "$SINK/garrison/" 2>/dev/null \
  || echo "[evidence-backup] $NODE: ~/.garrison pull incomplete (dir may not exist yet)"

# Root 2: ~/.walkthrough/runs — the finished artifacts, never the work dirs.
rsync -a $DRY --prune-empty-dirs \
  --include='*/' \
  --include='final.mp4' \
  --include='manifest.json' \
  --include='storyboard.json' \
  --exclude='frames/**' \
  --exclude='work/**' \
  --exclude='*' \
  -e "ssh -o BatchMode=yes" \
  "$TARGET:.walkthrough/runs/" "$SINK/walkthrough/" 2>/dev/null \
  || echo "[evidence-backup] $NODE: ~/.walkthrough pull skipped (absent is normal)"

# Sink-side rolling prune: seven days, then git/cards/memory are the record.
find "$SINK" -type f -mtime +7 -delete 2>/dev/null || true
find "$SINK" -type d -empty -delete 2>/dev/null || true

echo "[evidence-backup] $NODE -> $SINK ($(du -sh "$SINK" 2>/dev/null | cut -f1))"
