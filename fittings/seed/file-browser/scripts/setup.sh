#!/usr/bin/env bash
# File Browser setup: ensure the scoped workspace root exists. No deps (pure Node
# http + fs). Idempotent.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 18+ and re-run" >&2
  exit 1
fi

garrison_home="${GARRISON_HOME:-$HOME/.garrison}"
root="${GARRISON_FILEBROWSER_ROOT:-$garrison_home/files}"
# expand a leading ~
root="${root/#\~/$HOME}"
mkdir -p "$root"
# Seed the shared artifact namespaces (never overwrites anything).
for ns in documents recordings runs uploads; do
  mkdir -p "$root/$ns"
done

echo "file-browser setup ok ($root)"
