#!/usr/bin/env bash
# Snapshots Fitting shared environment.
#
# SOURCED by the other scripts (never executed directly), so it must not
# `set -e` or `exit` - a failure here would take the caller's shell down with it.
# It resolves the restic repository + credentials from two ordered sources and
# leaves everything exported:
#
#   1. the process environment - a RESTIC_REPOSITORY override wins outright
#      (this is how local proving points restic at a throwaway on-disk repo).
#   2. the Vault-materialized composition env ($GARRISON_COMPOSITION_DIR/.env),
#      which is authoritative for anything it defines.
#   3. the machine-local fallback file (~/.garrison/snapshots/env, 0600 KEY=value
#      lines), which fills ONLY the gaps the Vault left unset - so a bare box
#      with no Garrison running (e.g. the systemd timer) still has credentials.

# State/reporting home. Honors GARRISON_HOME so the sandbox stays isolated.
SNAPSHOTS_HOME="${GARRISON_HOME:-$HOME/.garrison}/snapshots"
export SNAPSHOTS_HOME
mkdir -p "$SNAPSHOTS_HOME" 2>/dev/null || true

# 2. Vault-materialized composition env (authoritative for what it sets).
if [ -n "${GARRISON_COMPOSITION_DIR:-}" ] && [ -f "$GARRISON_COMPOSITION_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$GARRISON_COMPOSITION_DIR/.env"
  set +a
fi

# 3. Fallback file fills only the gaps the Vault (or the environment) left unset.
__snapshots_fill_gaps() {
  local file="$1" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # strip one layer of surrounding single or double quotes
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    if [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "$file"
}
__snapshots_fill_gaps "$SNAPSHOTS_HOME/env"

# Default the restic repository to the GCS backend when a bucket is known and no
# explicit RESTIC_REPOSITORY override is in force.
if [ -z "${RESTIC_REPOSITORY:-}" ] && [ -n "${SNAPSHOTS_BUCKET:-}" ]; then
  export RESTIC_REPOSITORY="gs:${SNAPSHOTS_BUCKET}:/garrison"
fi

# Projects root included in the backup set (default ~/dev; override via env).
export SNAPSHOTS_PROJECTS_ROOT="${SNAPSHOTS_PROJECTS_ROOT:-${GARRISON_PROJECTS_ROOT:-$HOME/dev}}"

# restic reads GOOGLE_APPLICATION_CREDENTIALS for the gs: backend; keep it
# exported (possibly empty) so callers see a consistent environment.
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-}"
