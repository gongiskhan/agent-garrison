#!/usr/bin/env bash
# Idempotent prep for project-viewer.
#
# Deliberately trivial. The renderer has no dependencies to install and no bundle
# to build, so there is nothing here that could fail on a cold machine. That is
# also why this fitting is immune to the setup-cwd-vs-runtime-cwd divergence:
# setup runs inside apm_modules while the runtime serves from fittings/seed, so
# anything setup BUILT would be built in the wrong tree. It builds nothing.
set -euo pipefail

STORE_ROOT="${GARRISON_PROJECTVIEWER_STORE:-${GARRISON_HOME:-$HOME/.garrison}/project-viewer}"
mkdir -p "$STORE_ROOT/captures" "$STORE_ROOT/cache"

echo "project-viewer setup ok (store: $STORE_ROOT)"
