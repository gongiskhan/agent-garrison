#!/usr/bin/env bash
# Thin wrapper fired by the scheduler. The commit/rebase/push logic lives in the
# hardened ~/.claude/tools/obsidian-vault-sync.sh (single source of truth):
# non-destructive — commit local writes, pull --rebase --autostash, abort on
# conflict (never hard-reset), push. OBSIDIAN_VAULT is baked into the scheduler
# job command by setup.sh. Override the script path via OBSIDIAN_VAULT_SYNC_SCRIPT.
set -euo pipefail
SCRIPT="${OBSIDIAN_VAULT_SYNC_SCRIPT:-$HOME/.claude/tools/obsidian-vault-sync.sh}"
if [ ! -f "$SCRIPT" ]; then
  echo "vault-git-sync: hardened sync script not found at $SCRIPT" >&2
  exit 1
fi
exec bash "$SCRIPT"
