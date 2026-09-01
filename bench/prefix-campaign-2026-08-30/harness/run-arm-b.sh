#!/usr/bin/env bash
# Arm B: one plain Claude Code session against a fresh seed-v1 checkout,
# routed through the measurement proxy so the same instrument reads both arms.
set -u
N="$1"; PORT="$2"; DIR="$HOME/dev/armB-$N"
rm -rf "$DIR"
git clone -q --no-local "$HOME/bench/todo-seed" "$DIR" && git -C "$DIR" -c advice.detachedHead=false checkout -q seed-v1
OUT="$HOME/bench/runs/armB-$N"
node "$HOME/bench/measure-proxy.mjs" "$PORT" "$OUT.proxy.jsonl" > "$OUT.proxy.log" 2>&1 &
PROXY_PID=$!
sleep 1
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT.start"
START=$(date +%s)
cd "$DIR" && ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  timeout 5400 claude -p --output-format json --model sonnet --permission-mode bypassPermissions \
  < "$HOME/bench/TASK.md" > "$OUT.result.json" 2> "$OUT.err"
CODE=$?
END=$(date +%s)
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT.end"
echo $((END-START)) > "$OUT.seconds"
kill $PROXY_PID 2>/dev/null
echo "armB-$N exit=$CODE wall=$((END-START))s exchanges=$(wc -l < "$OUT.proxy.jsonl")"
