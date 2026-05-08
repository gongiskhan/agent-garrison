#!/usr/bin/env bash
# coding-subagent verify. Probes that the CLI loads, the SDK resolves, and
# the consumed CLIs (projects-index, documents) are reachable.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITION_DIR="$(cd "$FITTING_DIR/../../.." && pwd)"

# 1. CLI itself loads.
if ! node "$FITTING_DIR/scripts/coding-subagent.mjs" --probe >/dev/null 2>&1; then
  echo "coding-subagent verify: CLI --probe failed" >&2
  exit 1
fi

# 2. projects-index reachable.
PROJECTS_CLI="$COMPOSITION_DIR/apm_modules/_local/projects-index/scripts/projects.py"
if [ ! -f "$PROJECTS_CLI" ]; then
  echo "coding-subagent verify: projects-index not installed at $PROJECTS_CLI" >&2
  exit 1
fi

# 3. documents reachable.
DOCS_CLI="$COMPOSITION_DIR/apm_modules/_local/documents/scripts/documents.py"
if [ ! -f "$DOCS_CLI" ]; then
  echo "coding-subagent verify: documents not installed at $DOCS_CLI" >&2
  exit 1
fi

echo "ok"
