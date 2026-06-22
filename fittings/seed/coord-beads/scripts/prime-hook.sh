#!/usr/bin/env sh
# Fail-open, self-bounded Beads SessionStart prime.
#
# Installed to a STABLE location (~/.garrison/bin/coord-beads-prime.sh) by
# install-hooks.mjs so the SessionStart hook command never depends on the
# fitting's apm_modules path surviving a reinstall.
#
# Guarantees (Codex finding #4 — never block a session):
#   - exits 0 ALWAYS
#   - enforces its OWN short timeout so a wedged `bd` can't stall session start
#     up to Claude Code's hook timeout
#   - emits bd's hookSpecificOutput JSON on success; emits empty additionalContext
#     on ANY failure / timeout / missing bd / repo with no .beads graph
EMPTY='{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'

if ! command -v bd >/dev/null 2>&1; then
  printf '%s' "$EMPTY"
  exit 0
fi

tmp=$(mktemp 2>/dev/null) || { printf '%s' "$EMPTY"; exit 0; }

# Run bd in the background; a watchdog kills it after the budget. wait returns
# bd's real exit status (or 143 if the watchdog killed it).
bd prime --hook-json >"$tmp" 2>/dev/null &
bdpid=$!
( sleep 5; kill "$bdpid" 2>/dev/null ) >/dev/null 2>&1 &
watch=$!
wait "$bdpid" 2>/dev/null
rc=$?
kill "$watch" 2>/dev/null

if [ "$rc" -eq 0 ] && [ -s "$tmp" ]; then
  cat "$tmp"
else
  printf '%s' "$EMPTY"
fi
rm -f "$tmp" 2>/dev/null
exit 0
