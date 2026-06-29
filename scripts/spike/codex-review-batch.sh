#!/usr/bin/env bash
# Serial Codex 3A adversarial-review runner (one codex exec at a time, run-wide).
# Usage: codex-review-batch.sh <round> <slice> <base> <commit> "<acceptance>" [<slice> <base> <commit> "<acceptance>" ...]
# Reviews each slice's own commit diff (base..commit) PLUS any uncommitted changes.
set -uo pipefail
cd /Users/ggomes/dev/garrison
RUNDIR="docs/autothing/runs/20260622-143110-e93ec4b5"
ASSETS="$HOME/.claude/skills/autothing/assets"
ROUND="$1"; shift
while [ "$#" -ge 4 ]; do
  SLICE="$1"; BASE="$2"; COMMIT="$3"; ACC="$4"; shift 4
  mkdir -p "$RUNDIR/slices/$SLICE"
  OUT="$RUNDIR/slices/$SLICE/codex-review-$SLICE-r$ROUND.json"
  echo "===== 3A review: $SLICE (diff $BASE..$COMMIT) round $ROUND ====="
  codex exec -s read-only --skip-git-repo-check -C "$PWD" \
    --output-schema "$ASSETS/codex-review.schema.json" \
    --output-last-message "$OUT" \
    "You are doing an ADVERSARIAL review of slice '$SLICE'. Inspect ONLY its changes: run \`git --no-pager diff $BASE $COMMIT\` and \`git --no-pager diff\` (uncommitted). Slice acceptance: $ACC. Find the strongest MATERIAL reasons this should not ship (correctness, missing-case, empty/null/timeout paths, schema/version skew, races, observability gaps, false confidence in the committed test). Return ONLY JSON matching the schema. verdict=approve only if you cannot support any material, defensible finding from the diff; otherwise needs-attention with grounded findings." </dev/null >/dev/null 2>&1
  V=$(python3 -c "import json;print(json.load(open('$OUT')).get('verdict','READ-FAIL'))" 2>/dev/null || echo READ-FAIL)
  echo "VERDICT[$SLICE]=$V"
done
echo "BATCH DONE"
