#!/usr/bin/env bash
# CO3 evidence — the PLAN-GATE sequence over the REAL stdio MCP transport:
# A grants -> B waits -> A releases -> B inherits A's plan in the read-bundle.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 1
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; sleep 0.5; }

SB=$(mktemp -d /tmp/co3-demo.XXXX); export GARRISON_HOME="$SB"
SRV="fittings/seed/coord-mcp/scripts/server.mjs"
REPO="/tmp/garrison-coord-demo-repo"

call() { # $1=session $2=tool $3=args-json ; prints the tool result
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" \
    | COORD_SESSION="$1" node "$SRV" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s.trim());console.log(JSON.stringify(JSON.parse(m.result.content[0].text),null,1))})'
}

say "PLAN-GATE — only one session plans a repo at a time (stdio MCP)"
echo "repo = $REPO"; sleep 0.4

say "1. Session A: begin_planning -> GRANTED (acquires the lock)"
call A begin_planning "{\"repo\":\"$REPO\",\"summary\":\"refactor the capability resolver\"}" | grep -E 'status|summary' | head -3
sleep 0.6

say "2. Session B: begin_planning (SAME repo) -> WAIT (A holds it)"
call B begin_planning "{\"repo\":\"$REPO\",\"summary\":\"rework the runner\"}" | grep -E 'status|session|summary|message' | head -6
sleep 0.8

say "3. Session A: end_planning -> RELEASED"
call A end_planning "{\"repo\":\"$REPO\"}" | grep -E 'status'
sleep 0.6

say "4. Session B: begin_planning -> GRANTED, read-bundle CONTAINS A's plan"
call B begin_planning "{\"repo\":\"$REPO\",\"summary\":\"rework the runner\"}" | grep -E 'status|releasedPlan|summary|session' | head -8
sleep 0.8

say "PLAN-GATE OK"
rm -rf "$SB"
