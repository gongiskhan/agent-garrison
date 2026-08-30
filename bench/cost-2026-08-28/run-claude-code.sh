#!/usr/bin/env bash
# Baseline: one real, separate, non-interactive Claude Code session.
# NOT a Task subagent - a subagent runs inside the calling session, lands in that
# session's transcript, and is not what a normal Claude Code session looks like.
set -u
DIR="$HOME/dev/bench-todo-cc"
PROMPT="$1"
OUT="$2"
cd "$DIR"
START=$(date -u +%s)
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT.start"
claude -p --output-format json --model opus --permission-mode bypassPermissions < "$PROMPT" > "$OUT" 2> "$OUT.err"
CODE=$?
END=$(date -u +%s)
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT.end"
echo $((END-START)) > "$OUT.seconds"
echo "exit=$CODE wall=$((END-START))s"
