#!/usr/bin/env bash
# Thin wrapper fired by the scheduler and the session hooks. The
# commit/rebase/push logic lives IN-TREE at scripts/obsidian-vault-sync.sh —
# the single driver on every mesh node (2026-08-24 reconciliation: the
# out-of-repo systemd timer and the drifted ~/.claude/tools copy are retired;
# the one live feature that copy had over this one, the Claude memory mirror,
# was ported into the in-tree script, which runs it fail-closed wherever the
# mirror exists).
#
# Resolution order: an explicit OBSIDIAN_VAULT_SYNC_SCRIPT override, then the
# in-tree script. The old ~/.claude/tools preference is gone on purpose — it
# is how a drifted copy silently kept winning on one machine.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${OBSIDIAN_VAULT_SYNC_SCRIPT:-}" ]; then
  SCRIPT="$OBSIDIAN_VAULT_SYNC_SCRIPT"
else
  SCRIPT="$SELF_DIR/obsidian-vault-sync.sh"
fi
if [ ! -f "$SCRIPT" ]; then
  echo "vault-git-sync: sync script not found at $SCRIPT" >&2
  exit 1
fi
exec bash "$SCRIPT" "$@"
