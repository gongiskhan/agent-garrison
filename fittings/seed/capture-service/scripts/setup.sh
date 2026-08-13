#!/usr/bin/env bash
# Setup hook — side-effect-causing prep only; verify stays read-only.
# The fitting's only dependency (ws) is a repo-root dependency resolved by
# Node's upward walk (kanban-loop / web-channel precedent), so there is
# nothing to install. Kept as a hook so later milestones have a home for real
# prep without an apm.yml change.
set -euo pipefail
echo "[capture-service] setup: nothing to do"
