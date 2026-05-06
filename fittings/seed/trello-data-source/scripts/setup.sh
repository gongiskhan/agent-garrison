#!/usr/bin/env bash
# Trello Fitting setup. Validates Python and credentials before verify.
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

missing=0
for var in TRELLO_KEY TRELLO_TOKEN TRELLO_BOARD_ID; do
  if [ -z "${!var:-}" ]; then
    echo "${var} is not set; resolve via vault or composition config" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

echo "trello setup ok (python ${py_version})"
