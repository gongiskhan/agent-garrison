#!/usr/bin/env bash
# Take a restic snapshot of the Garrison state set and record the outcome to
# ~/.garrison/snapshots/state.json (atomically). Safe to run from Garrison (the
# Snapshots view) or from the systemd user timer - it sources the same env.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env.sh"

STATE_DIR="$SNAPSHOTS_HOME"
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$STATE_DIR/backup.log"
EXCLUDES="$SCRIPT_DIR/excludes.txt"
mkdir -p "$STATE_DIR"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  printf '%s' "$s"
}

write_state() {
  # write_state <ok:true|false> <bytes|""> <error|"">
  local ok="$1" bytes="$2" err="$3"
  local tmp="$STATE_DIR/.state.json.$$"
  {
    printf '{\n'
    printf '  "lastRun": "%s",\n' "$(now)"
    printf '  "ok": %s' "$ok"
    if [ -n "$bytes" ]; then printf ',\n  "bytes": %s' "$bytes"; fi
    if [ -n "$err" ]; then printf ',\n  "error": "%s"' "$(json_escape "$err")"; fi
    printf '\n}\n'
  } > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

if ! command -v restic >/dev/null 2>&1; then
  write_state false "" "restic is not installed"
  echo "restic is not installed; run: sudo apt-get install -y restic" >&2
  exit 1
fi

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  write_state false "" "no RESTIC_REPOSITORY configured"
  echo "FOLLOWUP: set SNAPSHOTS_BUCKET (GCS) or RESTIC_REPOSITORY in the Vault or ~/.garrison/snapshots/env" >&2
  exit 1
fi
if [ -z "${RESTIC_PASSWORD:-}" ] && [ -z "${RESTIC_PASSWORD_FILE:-}" ]; then
  write_state false "" "no RESTIC_PASSWORD configured"
  echo "FOLLOWUP: set RESTIC_PASSWORD in the Vault or ~/.garrison/snapshots/env" >&2
  exit 1
fi

# Build the backup set from the paths that actually exist.
SET=()
for d in "${GARRISON_HOME:-$HOME/.garrison}" "${GARRISON_CLAUDE_HOME:-$HOME/.claude}" "$SNAPSHOTS_PROJECTS_ROOT"; do
  [ -e "$d" ] && SET+=("$d")
done
if [ "${#SET[@]}" -eq 0 ]; then
  write_state false "" "backup set is empty"
  echo "nothing to back up (none of the expected paths exist)" >&2
  exit 1
fi

# Initialize the repository on first use. A present repo makes `snapshots`
# succeed and we skip init; otherwise init once (idempotent thereafter).
if ! restic snapshots >/dev/null 2>>"$LOG_FILE"; then
  restic init >>"$LOG_FILE" 2>&1 || true
fi

# Keep restic's --json stream OUT of the backup set (STATE_DIR lives under
# ~/.garrison, which we back up) so it never captures its own in-progress output.
TMP_JSON="${TMPDIR:-/tmp}/garrison-snapshot-backup.$$.json"
restic backup "${SET[@]}" --exclude-file "$EXCLUDES" --json >"$TMP_JSON" 2>>"$LOG_FILE"
rc=$?
BYTES="$(grep -o '"total_bytes_processed":[0-9]\+' "$TMP_JSON" 2>/dev/null | tail -1 | grep -o '[0-9]\+' || true)"
rm -f "$TMP_JSON"

if [ "$rc" -eq 0 ]; then
  write_state true "${BYTES:-}" ""
  echo "snapshot complete${BYTES:+ (${BYTES} bytes processed)}"
else
  write_state false "${BYTES:-}" "restic backup exited $rc (see $LOG_FILE)"
  echo "snapshot failed (exit $rc); see $LOG_FILE" >&2
  exit "$rc"
fi
