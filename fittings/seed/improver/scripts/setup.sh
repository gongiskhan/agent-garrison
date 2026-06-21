#!/usr/bin/env bash
# Improver setup — register the nightly run with the scheduler (morning-briefing
# pattern: CLI shell-out from the consumer's setup). Idempotent: remove then add.
set -euo pipefail

CRON="${IMPROVER_CRON:-30 3 * * *}"
SCHEDULER="${GARRISON_SCHEDULER_CLI:-../scheduler/scripts/scheduler.mjs}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# IMPROVER_PROJECTS_DIR activates the skills two-phase loop (maintenance + the
# capped PTY model pass). Without it the runner falls back to the memory rule only.
RUN_CMD="IMPROVER_PROJECTS_DIR=\$HOME/.claude/projects node ${SELF_DIR}/improver.mjs run-now improver-nightly"

# ── persist dream-rule config ────────────────────────────────────────────────
# The dream (vault consolidation) phase config is read at RUN time by BOTH the
# nightly CLI and the own-port server. The scheduler runs the job with the
# daemon's env (not these injected config vars), and the own-port server is
# spawned with process.env (not the composition config) — so neither sees the
# composition's improver config directly. We snapshot it to dream-config.json in
# the data dir, which both read (env overrides the file). config→env injection
# (runner.ts) provides IMPROVER_* here at setup time.
DATA_DIR="${IMPROVER_DATA:-$HOME/.garrison/improver}"
VAULT_DIR="${IMPROVER_VAULT_DIR:-$HOME/ObsidianVault}"
MEMORY_DIR="${IMPROVER_MEMORY_DIR:-Memory}"
RETENTION="${IMPROVER_CHECKPOINT_RETENTION_DAYS:-14}"
DREAM_MODEL="${IMPROVER_DREAM_MODEL:-haiku}"
case "$(printf '%s' "${IMPROVER_MEMORY_PRIMARY:-false}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) PRIMARY="true" ;;
  *) PRIMARY="false" ;;
esac
mkdir -p "$DATA_DIR"
cat >"$DATA_DIR/dream-config.json" <<JSON
{
  "vaultDir": "${VAULT_DIR}",
  "memoryDir": "${MEMORY_DIR}",
  "memoryPrimary": ${PRIMARY},
  "checkpointRetentionDays": ${RETENTION},
  "dreamModel": "${DREAM_MODEL}"
}
JSON
echo "improver: dream-config.json written (memory_primary=${PRIMARY}, vault=${VAULT_DIR})"

if [ -f "$SCHEDULER" ]; then
  node "$SCHEDULER" remove improver-nightly >/dev/null 2>&1 || true
  # scheduler add is positional: add <id> <cron> <command...>
  node "$SCHEDULER" add improver-nightly "$CRON" "$RUN_CMD" || {
    echo "improver: scheduler add failed (non-fatal in dev)"; true
  }
  echo "improver: registered improver-nightly @ '${CRON}'"
else
  echo "improver: scheduler CLI not found at ${SCHEDULER} (skipping registration; register manually)"
fi
