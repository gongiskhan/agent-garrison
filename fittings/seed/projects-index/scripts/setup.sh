#!/usr/bin/env bash
# Projects-index Fitting setup. Validates Python 3.10+ and that
# PROJECTS_INDEX_ROOT (if set) resolves to a readable directory.
# Empty or absent root is fine — verify will catch it later.
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not on PATH; install Python 3.10+ and re-run" >&2
  exit 1
fi

py_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
py_major="$(echo "$py_version" | cut -d. -f1)"
py_minor="$(echo "$py_version" | cut -d. -f2)"
if [ "$py_major" -lt 3 ] || { [ "$py_major" -eq 3 ] && [ "$py_minor" -lt 10 ]; }; then
  echo "python3 ${py_version} is too old; need 3.10+" >&2
  exit 1
fi

# Resolve the projects root for visibility. Tilde expansion via the
# shell here matches the script's runtime expansion.
ROOT="${PROJECTS_INDEX_ROOT:-$HOME/Projects}"
ROOT="${ROOT/#\~/$HOME}"

if [ ! -d "$ROOT" ]; then
  echo "[projects-index-setup] projects_root does not exist: $ROOT (verify will fail)" >&2
else
  echo "[projects-index-setup] projects_root: $ROOT"
fi

echo "projects-index setup ok (python ${py_version})"
