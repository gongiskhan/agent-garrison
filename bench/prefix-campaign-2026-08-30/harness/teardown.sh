#!/usr/bin/env bash
# Stop the eight apps and the review UI. Leaves verdicts.md and KEY.md alone.
set -u
for P in 3101 3102 3103 3104 3105 3106 3107 3108 3110; do
  fuser -k "$P/tcp" 2>/dev/null && echo "stopped :$P"
done
pkill -f "bench/review/server.mjs" 2>/dev/null
pkill -f "bench/review/apps/" 2>/dev/null
echo "done. verdicts.md and KEY.md untouched."
