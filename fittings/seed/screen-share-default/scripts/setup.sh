#!/usr/bin/env bash
# Probe screencapture availability and note macOS Screen Recording permission requirement.
set -e
if ! command -v screencapture &>/dev/null; then
  echo "screencapture not found — screen share requires macOS" >&2
  exit 1
fi
echo "screencapture available"
echo "NOTE: Screen Recording permission must be granted to the process that starts Garrison."
echo "  Open System Settings -> Privacy & Security -> Screen Recording and enable your terminal app."
