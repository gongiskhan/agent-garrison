#!/bin/sh
# Stands in for scripts/garrison-instance.sh in node-supervisor.test.ts, so
# the supervisor is exercised for real (real fork/exec, real signals, real
# process groups) without ever touching the actual Garrison node process,
# its ports, or the composition-owner lock.
#
# Appends one "started pid=<pid>" line to $NODE_SUPERVISOR_TEST_MARKERS on
# every invocation. Normally then blocks (simulating the long-lived node
# process) until it receives TERM, at which point it appends a "stopped"
# line and exits 0 - proving the supervisor's kill actually reached it.
# When NODE_SUPERVISOR_TEST_EXIT_IMMEDIATELY is set, it exits 7 right away
# instead, simulating a process that crashes on startup.

: "${NODE_SUPERVISOR_TEST_MARKERS:?fixture requires NODE_SUPERVISOR_TEST_MARKERS}"

echo "started pid=$$ args=$* GARRISON_NODE_NAME=${GARRISON_NODE_NAME:-<unset>} NVM_SOURCED_MARKER=${NVM_SOURCED_MARKER:-<unset>}" >> "$NODE_SUPERVISOR_TEST_MARKERS"

if [ -n "${NODE_SUPERVISOR_TEST_EXIT_IMMEDIATELY:-}" ]; then
  exit 7
fi

trap 'echo "stopped pid=$$" >> "$NODE_SUPERVISOR_TEST_MARKERS"; exit 0' TERM

while true; do
  sleep 1
done
