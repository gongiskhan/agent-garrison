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

# Group by host only. The default host+paths grouping split one node's history
# whenever its backup set changed (~/.claude vs a runtime home, a new
# mesh-conversations dir), and every group kept its own 7/4/6 set. Per-host
# grouping still never lets one node's policy thin another node's snapshots in
# the shared GCS repository.
restic forget --group-by host --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
rc=$?
node - "$SNAPSHOTS_HOME/prune.json" "$rc" <<'JS'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({lastRun: new Date().toISOString(), ok: process.argv[3] === '0', exitCode: Number(process.argv[3])}) + '\n', {mode: 0o600});
JS
node "$SCRIPT_DIR/schedule-status.mjs" --publish || true
exit "$rc"
