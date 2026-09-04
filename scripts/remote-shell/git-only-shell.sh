#!/bin/sh
# git-only-shell.sh - the forced `command=` for the tether's git-reverse-
# forward ssh key in dev-madrid's authorized_keys. That key exists for
# exactly one purpose (csg fetching/pushing this repo over the reverse
# tunnel) and must be able to do NOTHING else - no shell, no other command,
# no other repo - even if the key or the forward is ever reached from
# somewhere other than the tether.
#
# git's own ssh transport sends the command it wants via SSH_ORIGINAL_COMMAND
# (what a forced `command=` in authorized_keys overrides), not argv. This
# never re-interprets that string through a shell (no eval, no `sh -c`) - it
# matches it against an exact allowlist and, on a match, execs the SAME two
# argv git itself would build, built HERE rather than parsed out of the
# client's string. Anything that does not match exactly is refused outright.

set -eu

REPO="/home/ggomes/dev/garrison"
CMD="${SSH_ORIGINAL_COMMAND:-}"

case "$CMD" in
  "git-upload-pack '$REPO'" | "git-upload-pack \"$REPO\"")
    exec git-upload-pack "$REPO"
    ;;
  "git-receive-pack '$REPO'" | "git-receive-pack \"$REPO\"")
    exec git-receive-pack "$REPO"
    ;;
  *)
    echo "git-only-shell.sh: refused. Only git-upload-pack/git-receive-pack against $REPO are permitted." >&2
    exit 1
    ;;
esac
