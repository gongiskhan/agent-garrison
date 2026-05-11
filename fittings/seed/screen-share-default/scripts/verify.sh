#!/usr/bin/env bash
# Verify screencapture is on PATH.
set -e
if command -v screencapture &>/dev/null; then
  echo ok
else
  echo "screencapture not found — screen share requires macOS" >&2
  exit 1
fi
