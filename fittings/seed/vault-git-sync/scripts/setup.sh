#!/usr/bin/env bash
# vault-git-sync setup — register (idempotently) a nightly git-sync job with the
# scheduler. Mirrors the improver's setup pattern: a CLI shell-out to the
# scheduler from the consumer's setup. cwd is the fitting's installed dir
# (apm_modules/_local/vault-git-sync) per the runner contract.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"            # .../vault-git-sync/scripts
FITTING_DIR="$(cd "$SELF_DIR/.." && pwd)"            # .../vault-git-sync

# config→env injection (runner.ts) provides these at setup time.
# Mesh cadence (2026-08-24): 15-minute sync on every node + a nightly
# --require-fresh backstop whose minute is staggered per node (four nodes
# pushing the same remote at the same second is a needless conflict
# generator, and a hash needs no coordination).
CRON="${VAULT_GIT_SYNC_CRON:-*/15 * * * *}"
VAULT_DIR="${VAULT_GIT_SYNC_VAULT_DIR:-$HOME/ObsidianVault}"
# Expand a leading ~ NOW. setupConfigEnv (runner.ts) projects a `type: path`
# config value with a bare String(), so a configured "~/ObsidianVault" arrives
# literal. Baked into the job command it is then single-quoted and run through
# `/bin/sh -c`, where the tilde never expands - `cd "$VAULT"` fails and the job
# dies silently every night. That is exactly what happened here for weeks.
case "$VAULT_DIR" in
  "~") VAULT_DIR="$HOME" ;;
  "~/"*) VAULT_DIR="$HOME/${VAULT_DIR#\~/}" ;;
esac
SCHEDULER="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"

if [ ! -f "$SCHEDULER" ]; then
  echo "vault-git-sync: scheduler CLI not found at $SCHEDULER; add the scheduler fitting to your composition" >&2
  exit 1
fi

# Bake the vault dir into the job command (the scheduler daemon's env won't have
# the injected config). sync.sh delegates to the hardened sync script, which
# reads OBSIDIAN_VAULT. The scheduler runs the command via `/bin/sh -c`.
JOB_CMD="OBSIDIAN_VAULT='$VAULT_DIR' bash '$FITTING_DIR/scripts/sync.sh'"

# register, not add: PRESERVES the user's enable/disable choice on re-register.
node "$SCHEDULER" register vault-git-sync "$CRON" -- "$JOB_CMD"
echo "vault-git-sync: registered @ '$CRON' (vault=$VAULT_DIR)"

# Nightly backstop: a FULL sync that refuses to lie — exit 75 when the lock
# was held and no sync happened. Minute staggered by node-name hash.
NODE_NAME="${GARRISON_NODE_NAME:-$(hostname -s | tr '[:upper:]' '[:lower:]')}"
STAGGER_MIN=$(( 0x$(printf %s "$NODE_NAME" | sha1sum | cut -c1-6) % 60 ))
BACKSTOP_CRON="$STAGGER_MIN 4 * * *"
BACKSTOP_CMD="OBSIDIAN_VAULT='$VAULT_DIR' bash '$FITTING_DIR/scripts/sync.sh' --require-fresh"
node "$SCHEDULER" register vault-git-sync-nightly "$BACKSTOP_CRON" -- "$BACKSTOP_CMD"
echo "vault-git-sync: nightly backstop @ '$BACKSTOP_CRON' (node=$NODE_NAME)"
