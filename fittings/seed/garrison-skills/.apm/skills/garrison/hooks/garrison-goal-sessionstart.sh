#!/usr/bin/env bash
# garrison SessionStart guard — cleanup of orphaned per-session goal sentinels.
#
# With per-session sentinels (<home>/sentinels/<session_id>.json) there is no
# cross-session clobber to repair, so this only sweeps sentinels left behind by runs
# that crashed/ended without completing. An ACTIVE run rewrites its sentinel every
# turn (the Stop hook bumps `iteration`), so its mtime stays fresh and it is NOT
# swept; only files untouched for >2 days are removed.
#
# TRANSITION SAFETY (autothing->garrison rename, RUN_SPEC A5): new runs live under
# ~/.garrison/sentinels/, but a legacy in-flight run may still live under
# ~/.autothing/sentinels/. This guard creates the garrison home and sweeps BOTH homes
# (only the ones that exist), so it never disturbs a live legacy run.
#
# FAIL SAFE: never errors out the session start.
set -u
mkdir -p "${HOME}/.garrison/sentinels" 2>/dev/null || true
for DIR in "${HOME}/.garrison/sentinels" "${HOME}/.autothing/sentinels"; do
  [ -d "$DIR" ] || continue
  find "$DIR" -type f -name '*.json' -mtime +2 -delete 2>/dev/null || true
done
exit 0
