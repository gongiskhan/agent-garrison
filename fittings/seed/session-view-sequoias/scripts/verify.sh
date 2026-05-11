#!/usr/bin/env bash
# State file is optional — Sequoias creates it on first run.
# Verify the ~/.sequoias directory is either absent (first run) or readable.
SEQUOIAS_STATE="$HOME/.sequoias/state.json"
if [ -f "$SEQUOIAS_STATE" ] && ! [ -r "$SEQUOIAS_STATE" ]; then
  echo "~/.sequoias/state.json exists but is not readable" >&2
  exit 1
fi
echo ok
