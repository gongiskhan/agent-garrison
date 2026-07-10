#!/usr/bin/env bash
# autothing SessionStart guard — cleanup of orphaned per-session goal sentinels.
#
# With per-session sentinels (~/.autothing/sentinels/<session_id>.json) there is no
# cross-session clobber to repair, so this only sweeps sentinels left behind by runs
# that crashed/ended without completing. An ACTIVE run rewrites its sentinel every
# turn (the Stop hook bumps `iteration`), so its mtime stays fresh and it is NOT
# swept; only files untouched for >2 days are removed.
#
# FAIL SAFE: never errors out the session start.
set -u
DIR="${HOME}/.autothing/sentinels"
mkdir -p "$DIR" 2>/dev/null || true
find "$DIR" -type f -name '*.json' -mtime +2 -delete 2>/dev/null || true
exit 0
