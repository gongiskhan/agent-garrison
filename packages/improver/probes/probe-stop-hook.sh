#!/usr/bin/env bash
# probe-stop-hook.sh — the Improver Probe's Stop hook (GARRISON-FLOW-V2 S8).
#
# A thin, FAIL-SAFE wrapper: it forwards the Stop payload (stdin) to the node
# generator and relays the generator's stdout verbatim. The generator owns all
# gating + generation (probe-generate.mjs); keeping the bash side trivial means the
# gate logic stays node-unit-testable and this hook can only ever do one of two
# things — print the generator's {decision:"block",...} line, or nothing.
#
# The generator itself already fails closed (any error → no stdout, exit 0). This
# wrapper adds a second belt: node's stderr is diverted to the skip log and every
# failure path still `exit 0`s, so a broken probe NEVER blocks a real Stop.
#
# Registered (additive, idempotent) into ~/.claude/settings.json Stop hooks by
# install-probe-hooks.mjs. Coexists with the goal-loop Stop hook (Claude Code runs
# all Stop hooks); the generator defers to the goal loop when a sentinel is armed.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
GEN="$DIR/probe-generate.mjs"
SKIPLOG="${GARRISON_HOME:-$HOME/.garrison}/improver/probe-skip.log"

INPUT="$(cat 2>/dev/null || true)"

# Missing node or generator → silently allow the stop.
command -v node >/dev/null 2>&1 || exit 0
[ -f "$GEN" ] || exit 0

OUT="$(printf '%s' "$INPUT" | node "$GEN" 2>>"$SKIPLOG" || true)"
[ -n "$OUT" ] && printf '%s' "$OUT"
exit 0
