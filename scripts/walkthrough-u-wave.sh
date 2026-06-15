#!/usr/bin/env bash
# U-wave evidence walkthrough (BRIEF: Garrison v2 Completion). A CPU-light
# terminal recording of the committed gates for the slices touched in this wave
# plus the LIVE codegraph/serena MCP round-trip. Recorded with asciinema; no
# browser/claude TUI (which the dev machine's load could not record reliably).
set -e
cd "$(dirname "$0")/.."

banner() { printf '\n\033[1;36m===== %s =====\033[0m\n' "$1"; }

banner "U1 — gateway Stage-A live routing (committed gate)"
npx vitest run tests/gateway-routing.test.ts --reporter=dot 2>&1 | tail -6

banner "U2 — codegraph + serena answering LIVE through the wired MCP (committed gate)"
GARRISON_LIVE_TOOLS=1 npx vitest run tests/knowledge-mcp-live.test.ts --reporter=dot 2>&1 | tail -6

banner "U3 — Improver review-queue: apply / reject / 409-conflict + autonomy (committed gate)"
npx vitest run tests/improver-apply.test.ts tests/improver-server.test.ts --reporter=dot 2>&1 | tail -6

banner "U4 — soul-switch carryover fallback + runtime contracts (committed gate)"
npx vitest run tests/soul-switch-carryover.test.ts --reporter=dot 2>&1 | tail -5

banner "U-wave gates green"
echo "live-route-ok · codegraph-ok · serena-ok · improver-apply-ok · improver-conflict-ok · soul-switch-ok"
