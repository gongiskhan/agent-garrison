#!/usr/bin/env bash
# Emit a small JSON envelope describing the repository state for the Snapshots
# view: the resolved repository, any error, and the snapshots list (restic's own
# JSON array). Read-only; degrades to an empty list + a clear error when
# credentials or restic are absent.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env.sh"

repo="${RESTIC_REPOSITORY:-}"
snaps="[]"
err=""

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if ! command -v restic >/dev/null 2>&1; then
  err="restic is not installed"
elif [ -z "$repo" ]; then
  err="no repository configured (set SNAPSHOTS_BUCKET or RESTIC_REPOSITORY)"
else
  tmperr="$(mktemp)"
  if out="$(restic snapshots --json 2>"$tmperr")"; then
    snaps="$out"
  else
    err="$(tr '\n' ' ' < "$tmperr")"
  fi
  rm -f "$tmperr"
fi

printf '{"repository":"%s","error":"%s","snapshots":%s}\n' \
  "$(json_str "$repo")" "$(json_str "$err")" "$snaps"
