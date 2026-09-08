#!/bin/sh
# Stands in for `ssh` in csg-node-redeploy.test.ts: records every invocation
# to $FAKE_SSH_CALLS (one line each) then always fails, simulating csg being
# unreachable (tether down) - the most likely real-world failure mode for
# this script, and the one whose error message matters most.
: "${FAKE_SSH_CALLS:?fixture requires FAKE_SSH_CALLS}"
echo "ssh $*" >> "$FAKE_SSH_CALLS"
exit 255
