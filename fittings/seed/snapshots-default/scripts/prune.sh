#!/usr/bin/env bash
# Apply the retention policy and reclaim space. Driven weekly by the systemd
# timer, deliberately separate from the daily backup so a prune failure never
# blocks a backup.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env.sh"

command -v restic >/dev/null 2>&1 || { echo "restic is not installed" >&2; exit 1; }
[ -n "${RESTIC_REPOSITORY:-}" ] || { echo "FOLLOWUP: no RESTIC_REPOSITORY configured" >&2; exit 1; }

exec restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
