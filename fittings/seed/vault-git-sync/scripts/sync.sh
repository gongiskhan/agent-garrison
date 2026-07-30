#!/usr/bin/env bash
# Thin wrapper fired by the scheduler. The commit/rebase/push logic lives in the
# hardened ~/.claude/tools/obsidian-vault-sync.sh (single source of truth):
# non-destructive — commit local writes, pull --rebase --autostash, abort on
# conflict (never hard-reset), push. OBSIDIAN_VAULT is baked into the scheduler
# job command by setup.sh. Override the script path via OBSIDIAN_VAULT_SYNC_SCRIPT.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${GARRISON_CLAUDE_HOME:-$HOME/.claude}"
# Resolution order: an explicit override, then the operator's hardened copy if it
# exists, then the IN-TREE script. The in-tree copy is what makes this work on a
# machine APM installed the fitting onto - ~/.claude/tools is a separate,
# remote-less repo that no fitting payload ships, so an outpost never had one.
if [ -n "${OBSIDIAN_VAULT_SYNC_SCRIPT:-}" ]; then
  SCRIPT="$OBSIDIAN_VAULT_SYNC_SCRIPT"
elif [ -f "$CLAUDE_HOME/tools/obsidian-vault-sync.sh" ]; then
  SCRIPT="$CLAUDE_HOME/tools/obsidian-vault-sync.sh"
else
  SCRIPT="$SELF_DIR/obsidian-vault-sync.sh"
fi
if [ ! -f "$SCRIPT" ]; then
  echo "vault-git-sync: sync script not found at $SCRIPT" >&2
  exit 1
fi
exec bash "$SCRIPT" "$@"
