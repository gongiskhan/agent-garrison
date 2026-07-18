#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# This checkout is the secondary comparison instance. Keep every writable
# control-plane/config surface away from the main Garrison process.
export GARRISON_INSTANCE_ID="${GARRISON_INSTANCE_ID:-codex}"
export GARRISON_HOME="${CODEX_GARRISON_HOME:-$HOME/.garrison-codex}"
export GARRISON_CLAUDE_HOME="${CODEX_GARRISON_CLAUDE_HOME:-$HOME/.claude-garrison-codex}"
export CLAUDE_CONFIG_DIR="$GARRISON_CLAUDE_HOME"
export GARRISON_CLAUDE_JSON="$GARRISON_CLAUDE_HOME/.claude.json"
export GARRISON_CLAUDE_CONFIG_PATH="$GARRISON_CLAUDE_JSON"
export GARRISON_CLAUDE_PROJECTS_DIR="$GARRISON_CLAUDE_HOME/projects"
export GARRISON_CLAUDE_SESSIONS_DIR="$GARRISON_CLAUDE_HOME/sessions"
export GARRISON_CLAUDE_SETTINGS_PATH="$GARRISON_CLAUDE_HOME/settings.json"
export GARRISON_VAULT_PATH="$GARRISON_HOME/vault.json"
export GARRISON_KEYCHAIN_SERVICE="${GARRISON_KEYCHAIN_SERVICE:-agent-garrison-vault-codex}"
export GARRISON_KEYCHAIN_ACCOUNT="${GARRISON_KEYCHAIN_ACCOUNT:-vault-master-key-codex}"
export GARRISON_KANBAN_DIR="$GARRISON_HOME/kanban-loop"
export GARRISON_AUTOMATIONS_DIR="$GARRISON_HOME/automations"
export GARRISON_POLICY_PATH="$GARRISON_HOME/orchestrator/policy.json"
export GARRISON_RUNS_DIR="$GARRISON_HOME/runs"
export GARRISON_SCHEDULER_JOBS="$GARRISON_HOME/scheduler-jobs.json"
export GARRISON_SCHEDULER_LOG="$GARRISON_HOME/scheduler.log"
export GARRISON_SCHEDULER_HEALTH_PORT=27999
export GARRISON_SCHEDULER_SCRIPT="${CODEX_GARRISON_SCHEDULER_SCRIPT:-$REPO_ROOT/fittings/seed/scheduler/scripts/scheduler.mjs}"
export GARRISON_TMUX_SOCKET_PATH="$GARRISON_HOME/tmux/dev-env.sock"
export GARRISON_APP_PORT="${CODEX_GARRISON_APP_PORT:-27777}"
export GARRISON_OUTPOST_PORT="${CODEX_GARRISON_OUTPOST_PORT:-23702}"
export GARRISON_DISABLE_HOST_DAEMONS=1
export CODEX_HOME="$GARRISON_HOME/runtime-homes/codex"
export GEMINI_CLI_HOME="$GARRISON_HOME/runtime-homes/gemini"
export BASIC_MEMORY_CONFIG_DIR="$GARRISON_HOME/basic-memory"
export BASIC_MEMORY_HOME="$GARRISON_HOME/basic-memory/default"
export XDG_CONFIG_HOME="$GARRISON_HOME/xdg/config"
export XDG_DATA_HOME="$GARRISON_HOME/xdg/data"
export XDG_CACHE_HOME="$GARRISON_HOME/xdg/cache"
export PLAYWRIGHT_BROWSERS_PATH="$GARRISON_HOME/playwright-browsers"
export UV_CACHE_DIR="$GARRISON_HOME/uv/cache"
export UV_TOOL_DIR="$GARRISON_HOME/uv/tools"
export UV_TOOL_BIN_DIR="$GARRISON_HOME/uv/bin"
export npm_config_cache="$GARRISON_HOME/npm-cache"
export PATH="$GARRISON_HOME/bin:$UV_TOOL_BIN_DIR:$PATH"

mode="${1:-start}"
case "$mode" in
  start|dev)
    exec concurrently --kill-others-on-fail --names next,outpost,scheduler \
      "next dev -H 127.0.0.1 -p $GARRISON_APP_PORT" \
      "node scripts/outpost-host.mjs" \
      "node \"$GARRISON_SCHEDULER_SCRIPT\" daemon --health-port $GARRISON_SCHEDULER_HEALTH_PORT"
    ;;
  next)
    exec next dev -H 127.0.0.1 -p "$GARRISON_APP_PORT"
    ;;
  mobile)
    exec concurrently --kill-others-on-fail --names next,outpost,scheduler \
      "next dev -H 0.0.0.0 -p $GARRISON_APP_PORT" \
      "node scripts/outpost-host.mjs" \
      "node \"$GARRISON_SCHEDULER_SCRIPT\" daemon --health-port $GARRISON_SCHEDULER_HEALTH_PORT"
    ;;
  env)
    for key in \
      GARRISON_INSTANCE_ID GARRISON_HOME GARRISON_CLAUDE_HOME CLAUDE_CONFIG_DIR \
      GARRISON_CLAUDE_JSON GARRISON_CLAUDE_CONFIG_PATH \
      GARRISON_CLAUDE_PROJECTS_DIR GARRISON_CLAUDE_SESSIONS_DIR \
      GARRISON_CLAUDE_SETTINGS_PATH GARRISON_VAULT_PATH \
      GARRISON_KEYCHAIN_SERVICE GARRISON_KEYCHAIN_ACCOUNT \
      GARRISON_KANBAN_DIR GARRISON_AUTOMATIONS_DIR \
      GARRISON_POLICY_PATH GARRISON_RUNS_DIR \
      GARRISON_SCHEDULER_JOBS GARRISON_SCHEDULER_LOG \
      GARRISON_SCHEDULER_HEALTH_PORT GARRISON_SCHEDULER_SCRIPT \
      GARRISON_TMUX_SOCKET_PATH \
      GARRISON_APP_PORT \
      GARRISON_OUTPOST_PORT GARRISON_DISABLE_HOST_DAEMONS \
      CODEX_HOME GEMINI_CLI_HOME \
      BASIC_MEMORY_CONFIG_DIR BASIC_MEMORY_HOME \
      XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME \
      PLAYWRIGHT_BROWSERS_PATH UV_CACHE_DIR UV_TOOL_DIR UV_TOOL_BIN_DIR \
      npm_config_cache
    do
      printf '%s=%s\n' "$key" "${!key}"
    done
    ;;
  *)
    echo "usage: $0 {start|dev|next|mobile|env}" >&2
    exit 2
    ;;
esac
