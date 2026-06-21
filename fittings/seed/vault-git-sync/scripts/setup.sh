#!/usr/bin/env bash
# vault-git-sync setup — register (idempotently) a nightly git-sync job with the
# scheduler. Mirrors the improver's setup pattern: a CLI shell-out to the
# scheduler from the consumer's setup. cwd is the fitting's installed dir
# (apm_modules/_local/vault-git-sync) per the runner contract.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"            # .../vault-git-sync/scripts
FITTING_DIR="$(cd "$SELF_DIR/.." && pwd)"            # .../vault-git-sync

# config→env injection (runner.ts) provides these at setup time.
CRON="${VAULT_GIT_SYNC_CRON:-0 4 * * *}"
VAULT_DIR="${VAULT_GIT_SYNC_VAULT_DIR:-$HOME/ObsidianVault}"
SCHEDULER="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"

if [ ! -f "$SCHEDULER" ]; then
  echo "vault-git-sync: scheduler CLI not found at $SCHEDULER; add the scheduler fitting to your composition" >&2
  exit 1
fi

# Bake the vault dir into the job command (the scheduler daemon's env won't have
# the injected config). sync.sh delegates to the hardened sync script, which
# reads OBSIDIAN_VAULT. The scheduler runs the command via `/bin/sh -c`.
JOB_CMD="OBSIDIAN_VAULT='$VAULT_DIR' bash '$FITTING_DIR/scripts/sync.sh'"

node "$SCHEDULER" remove vault-git-sync >/dev/null 2>&1 || true
node "$SCHEDULER" add vault-git-sync "$CRON" "$JOB_CMD"
echo "vault-git-sync: registered @ '$CRON' (vault=$VAULT_DIR)"
