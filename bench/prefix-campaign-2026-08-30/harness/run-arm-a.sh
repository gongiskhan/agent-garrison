#!/usr/bin/env bash
# Arm A: one Garrison conversation against a fresh seed-v1 checkout.
# The checkout must be a direct child of ~/dev containing .git, because that is
# what resolveProjectName accepts; anything else degrades to the composition dir.
set -u
N="$1"; DIR="$HOME/dev/armA-$N"
rm -rf "$DIR"
git clone -q --no-local "$HOME/bench/todo-seed" "$DIR" && git -C "$DIR" -c advice.detachedHead=false checkout -q seed-v1
date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/bench/runs/armA-$N.start"
node /home/ggomes/dev/garrison/bench/round2/run-garrison.mjs \
  --prompt "$HOME/bench/TASK.md" \
  --title "Build a todo app in this repo" \
  --project "armA-$N" \
  --timeout 5400 \
  --out "$HOME/bench/runs/armA-$N.run.json" > "$HOME/bench/runs/armA-$N.log" 2>&1
date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/bench/runs/armA-$N.end"
tail -6 "$HOME/bench/runs/armA-$N.log"
