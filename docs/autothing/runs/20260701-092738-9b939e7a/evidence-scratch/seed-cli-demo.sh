#!/usr/bin/env bash
set -euo pipefail
TEMPDIR="$1"
mkdir -p "$TEMPDIR"
TARGET="$TEMPDIR/knowledge-memory.md"
printf '# Knowledge memory\n\nSomething else entirely overwrote this file.\n' > "$TARGET"
cat > "$TEMPDIR/review-queue.json" << JSON
[
  {
    "id": "demo-note-1",
    "rule": "memory-consolidation",
    "targetClass": "memory",
    "claim": "Remember: garrison tests run via npx vitest run",
    "diff": "+ Remember: garrison tests run via npx vitest run",
    "decision": "approved",
    "applyVia": "reconcile",
    "status": "applied",
    "at": "2026-06-30T00:00:00Z",
    "appliedAt": "2026-06-30T00:05:00Z",
    "evidence": { "targetFile": "$TARGET", "bytes": 10, "sha": "sha256:placeholder" }
  }
]
JSON
