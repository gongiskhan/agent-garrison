#!/usr/bin/env bash
# Integrity check of the restic repository (`restic check`). Called by the
# Snapshots view's Verify action. Read-only.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env.sh"

command -v restic >/dev/null 2>&1 || { echo "restic is not installed" >&2; exit 1; }
[ -n "${RESTIC_REPOSITORY:-}" ] || { echo "FOLLOWUP: no RESTIC_REPOSITORY configured" >&2; exit 1; }

exec restic check
