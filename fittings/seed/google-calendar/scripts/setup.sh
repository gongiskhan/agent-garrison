#!/usr/bin/env bash
# Google Calendar Fitting setup. Idempotent: re-run is safe.
#
# Behavior:
#   1. Check python3 >=3.10 and uv on PATH.
#   2. Validate vault-injected env vars.
#   3. uv sync to build .venv inside the installed Fitting.
#   4. Prepare ~/.garrison/google-calendar/ token dir at 0700.
#   5. Run calendar.py --setup (refresh existing token or OAuth loopback).
#   6. If scheduler Fitting is present, register a 5-min calendar-sync job.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
log() { printf '[google-calendar-setup] %s\n' "$*"; }

# 1. Required tools.
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not on PATH; install Python 3.10+ and re-run" >&2
  exit 1
fi
py_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
py_major="$(echo "$py_version" | cut -d. -f1)"
py_minor="$(echo "$py_version" | cut -d. -f2)"
if [ "$py_major" -lt 3 ] || { [ "$py_major" -eq 3 ] && [ "$py_minor" -lt 10 ]; }; then
  echo "python3 ${py_version} is too old; need 3.10+" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv not on PATH; install uv (https://docs.astral.sh/uv/) and re-run" >&2
  exit 1
fi

# 2. Vault-injected creds.
missing=0
for var in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET; do
  if [ -z "${!var:-}" ]; then
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "Missing Google OAuth credentials. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the vault. See instructions.md for how to obtain them." >&2
  exit 1
fi

# 3. uv sync.
log "uv sync --directory $FITTING_DIR"
uv sync --directory "$FITTING_DIR" --quiet

# 4. Token dir.
TOKEN_DIR="$HOME/.garrison/google-calendar"
mkdir -p "$TOKEN_DIR"
chmod 700 "$TOKEN_DIR"

# 5. Run --setup. Either refreshes silently or kicks off OAuth.
log "ensuring OAuth token (browser may open on first run)"
uv run --directory "$FITTING_DIR" --quiet python scripts/calendar.py --setup

# 6. Optional scheduler job registration.
SCHED="$(pwd)/apm_modules/_local/scheduler/scripts/scheduler.mjs"
if [ -f "$SCHED" ] && command -v node >/dev/null 2>&1; then
  if node "$SCHED" list 2>/dev/null | grep -q '"calendar-sync"'; then
    log "scheduler job calendar-sync already registered"
  else
    SYNC_CMD="bash $FITTING_DIR/scripts/calendar-sync-wrapper.sh"
    log "registering scheduler job calendar-sync */5 * * * *"
    node "$SCHED" add calendar-sync "*/5 * * * *" "$SYNC_CMD" >/dev/null
  fi
else
  log "scheduler not present in composition; skipping job registration"
fi

echo "ok"
