#!/usr/bin/env bash
# coord-agentmail verify (read-only) — uv present, external clone at the pin, and
# the agent_mail module is runnable. Prints "ok". Does NOT start a long-lived
# server. Honors GARRISON_HOME.
set -uo pipefail

GH="${GARRISON_HOME:-$HOME/.garrison}"
EXT="$GH/external/mcp_agent_mail"

if ! command -v uv >/dev/null 2>&1; then
  echo "verify-failed: uv not on PATH"
  exit 1
fi
if [ ! -d "$EXT/.git" ]; then
  echo "verify-failed: agent_mail clone missing at $EXT"
  exit 1
fi
# License isolation: must be outside the MIT tree.
case "$EXT" in
  */dev/garrison/*|*/Projects/garrison/*) echo "verify-failed: external clone INSIDE the MIT tree"; exit 1;;
esac
# Module runnable (arm's-length).
if ! ( cd "$EXT" && uv run python -m mcp_agent_mail.http --help >/dev/null 2>&1 ); then
  echo "verify-failed: agent_mail module not runnable"
  exit 1
fi

echo "ok"
