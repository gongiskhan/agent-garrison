#!/usr/bin/env bash
# Setup hook — side-effect-causing prep only; verify stays read-only.
# M0: nothing to prepare. The state directory is created lazily by the store,
# and no external tool is required. Kept as a hook so later milestones have a
# home for real prep without an apm.yml change.
set -euo pipefail
echo "[capture-service] setup: nothing to do"
