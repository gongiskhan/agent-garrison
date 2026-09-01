#!/usr/bin/env bash
# Baseline: one real, separate, non-interactive Claude Code session.
# NOT a Task subagent - a subagent runs inside the calling session, lands in
# that session's transcript, and is not what a normal Claude Code session looks
# like. The model is pinned explicitly: the CLI default hit a monthly spend
# limit in round one and returned 429, and a silently substituted model is not
# a baseline.
#
#   usage: run-claude-code.sh <dir> <prompt-file> <model> <out-json>
set -u
DIR="$1"; PROMPT="$2"; MODEL="$3"; OUT="$4"
cd "$DIR" || exit 2
START=$(date -u +%s)
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT.start"
claude -p --output-format json --model "$MODEL" --permission-mode bypassPermissions < "$PROMPT" > "$OUT" 2> "$OUT.err"
CODE=$?
END=$(date -u +%s)
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT.end"
echo $((END-START)) > "$OUT.seconds"
echo "exit=$CODE wall=$((END-START))s model=$MODEL"
# A spend limit or refusal is a BLOCKED side, never a quietly substituted model.
grep -o '"is_error":[a-z]*' "$OUT" 2>/dev/null | head -1
