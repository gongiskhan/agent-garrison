#!/usr/bin/env bash
# coord-agentmail setup — clone+pin mcp_agent_mail to ~/.garrison/external (OUTSIDE
# Garrison's MIT tree; license-isolated) and prepare its uv venv. Does NOT start
# the server (that is scripts/start.mjs, driven by Garrison's own-port lifecycle).
set -uo pipefail

PIN="${COORD_AGENTMAIL_PIN:-de9e6288367e20a8b81e203960da9219ab8aa48f}"
GH="${GARRISON_HOME:-$HOME/.garrison}"
EXT="$GH/external/mcp_agent_mail"
REPO="https://github.com/Dicklesworthstone/mcp_agent_mail.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[coord-agentmail] setup starting (pin $PIN)"

# 0) LICENSE ISOLATION GUARD — runs BEFORE any clone/write so agent_mail bytes can
#    never land inside the MIT tree. Resolve EXT absolutely and refuse if it is
#    inside this fitting's git toplevel (the Garrison source tree) or matches a
#    known repo path. (Codex CO2 #1.)
EXT_ABS="$(cd "$(dirname "$EXT")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename "$EXT")" || echo "$EXT")"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$REPO_ROOT" ] && case "$EXT_ABS/" in "$REPO_ROOT"/*) true;; *) false;; esac; then
  echo "[coord-agentmail] ERROR: external clone path ($EXT_ABS) is INSIDE the MIT tree ($REPO_ROOT) — aborting before any write"
  exit 1
fi
case "$EXT_ABS" in
  */dev/garrison/*|*/Projects/garrison/*)
    echo "[coord-agentmail] ERROR: external clone path ($EXT_ABS) matches a Garrison source path — aborting before any write"
    exit 1;;
esac

# 1) uv is required (arm's-length python runtime; never vendored).
if ! command -v uv >/dev/null 2>&1; then
  echo "[coord-agentmail] uv not found — attempting install"
  curl -LsSf https://astral.sh/uv/install.sh | sh || true
  export PATH="$HOME/.local/bin:$PATH"
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "[coord-agentmail] ERROR: uv could not be installed. Install uv (https://astral.sh/uv) and re-run."
  exit 1
fi

# 2) Clone + pin the external repo (license-isolated location, already guarded above).
mkdir -p "$GH/external"
if [ ! -d "$EXT/.git" ]; then
  echo "[coord-agentmail] cloning agent_mail (arm's-length, license-isolated) → $EXT"
  git clone --quiet "$REPO" "$EXT" || { echo "[coord-agentmail] ERROR: clone failed"; exit 1; }
fi
( cd "$EXT" && git fetch --quiet origin 2>/dev/null; git checkout --quiet "$PIN" ) || {
  echo "[coord-agentmail] ERROR: could not checkout pin $PIN"; exit 1; }
echo "[coord-agentmail] pinned at $(cd "$EXT" && git rev-parse HEAD)"

# 3) Prepare the venv (arm's-length; never imported into Garrison).
( cd "$EXT" && uv sync --quiet ) || { echo "[coord-agentmail] ERROR: uv sync failed"; exit 1; }

echo "[coord-agentmail] setup complete (server started separately via own-port lifecycle)"
