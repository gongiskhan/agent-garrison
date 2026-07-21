#!/usr/bin/env bash
# Profile-driven Garrison launcher — the ONLY sanctioned way to start an instance.
#
# HARD RULE: prod and dev never share a port, a GARRISON_HOME, or a Claude config
# dir. Every writable control-plane surface is projected per profile here; a bare
# `next dev` bypasses this and will scribble on whichever home it inherits.
#
#   profile  offset   app     gateway  outpost  fittings  scheduler  home
#   dev          0    7777     4777     3702     70xx      7099      ~/.garrison-dev
#   prod     +1000    8777     5777     4702     80xx      8099      ~/.garrison   (+ real ~/.claude)
#   codex   +20000   27777    24777    23702    270xx     27099      ~/.garrison-codex
#
# Fitting and gateway ports are NOT set here — they come from the composition's
# single committed port map, shifted by src/lib/instance-profile.ts. This script
# only sets the process-level listeners the composition does not declare.
#
# PROD is the always-on tailnet surface: it serves a BUILT app (`next start`
# against .next-prod) so a half-finished edit in the working tree cannot take
# the tailnet address down. Dev's `next dev` uses .next — the two dist dirs are
# kept apart deliberately (a shared .next silently breaks the dev server's
# dynamic routes; friction-log 2026-06-10).
#
# Usage:  scripts/garrison-instance.sh <prod|dev|codex> <start|dev|next|mobile|build|env>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

profile="${1:-}"
mode="${2:-start}"

case "$profile" in
  prod|dev|codex) ;;
  *)
    echo "usage: $0 {prod|dev|codex} {start|dev|next|mobile|build|env}" >&2
    exit 2
    ;;
esac

# --- profile identity -------------------------------------------------------
# Offsets MUST match PROFILE_PORT_OFFSET in src/lib/instance-profile.ts.
# tests/instance-isolation.test.ts pins both sides against each other.
case "$profile" in
  dev)
    PORT_OFFSET=0
    DEFAULT_HOME="$HOME/.garrison-dev"
    DEFAULT_CLAUDE_HOME="$HOME/.claude-garrison-dev"
    KEYCHAIN_SUFFIX="-dev"
    ;;
  prod)
    PORT_OFFSET=1000
    DEFAULT_HOME="$HOME/.garrison"
    # Prod is the real control plane: it owns the user's actual ~/.claude.
    # That is the whole point of Garrison — dev must never point here.
    DEFAULT_CLAUDE_HOME="$HOME/.claude"
    KEYCHAIN_SUFFIX=""
    ;;
  codex)
    PORT_OFFSET=20000
    DEFAULT_HOME="$HOME/.garrison-codex"
    DEFAULT_CLAUDE_HOME="$HOME/.claude-garrison-codex"
    KEYCHAIN_SUFFIX="-codex"
    ;;
esac

export GARRISON_INSTANCE_ID="$profile"
export GARRISON_PORT_OFFSET="$PORT_OFFSET"
export GARRISON_HOME="${GARRISON_HOME_OVERRIDE:-$DEFAULT_HOME}"
export GARRISON_CLAUDE_HOME="${GARRISON_CLAUDE_HOME_OVERRIDE:-$DEFAULT_CLAUDE_HOME}"

# --- process-level ports ----------------------------------------------------
export GARRISON_APP_PORT="${GARRISON_APP_PORT:-$((7777 + PORT_OFFSET))}"
export GARRISON_OUTPOST_PORT="${GARRISON_OUTPOST_PORT:-$((3702 + PORT_OFFSET))}"
export GARRISON_SCHEDULER_HEALTH_PORT="${GARRISON_SCHEDULER_HEALTH_PORT:-$((7099 + PORT_OFFSET))}"
# Next reads PORT; the runner's self-URL prefers GARRISON_APP_PORT but falls
# back to it, so keep them in lockstep.
export PORT="$GARRISON_APP_PORT"

# --- writable control-plane surfaces ---------------------------------------
# The Claude CLI keeps its user config at the SIBLING of its home
# ($HOME/.claude -> $HOME/.claude.json), NOT inside it. Setting
# CLAUDE_CONFIG_DIR to the real ~/.claude is therefore NOT a no-op: the CLI
# switches to <dir>/.claude.json, a stub without `theme`/`hasCompletedOnboarding`,
# and the interactive TUI boots into the "choose a text style" onboarding screen
# — which the gateway reports as `spawn-failed: waiting on a login/setup screen`.
# So prod (whose home IS the real ~/.claude) leaves CLAUDE_CONFIG_DIR unset and
# uses the sibling json; only the isolated profiles redirect the CLI.
# Mirrors the sibling rule in src/lib/claude-home.ts.
if [ "$GARRISON_CLAUDE_HOME" = "$HOME/.claude" ]; then
  unset CLAUDE_CONFIG_DIR
  export GARRISON_CLAUDE_JSON="$HOME/.claude.json"
else
  export CLAUDE_CONFIG_DIR="$GARRISON_CLAUDE_HOME"
  export GARRISON_CLAUDE_JSON="$GARRISON_CLAUDE_HOME/.claude.json"
fi
export GARRISON_CLAUDE_CONFIG_PATH="$GARRISON_CLAUDE_JSON"
export GARRISON_CLAUDE_PROJECTS_DIR="$GARRISON_CLAUDE_HOME/projects"
export GARRISON_CLAUDE_SESSIONS_DIR="$GARRISON_CLAUDE_HOME/sessions"
export GARRISON_CLAUDE_SETTINGS_PATH="$GARRISON_CLAUDE_HOME/settings.json"
export GARRISON_VAULT_PATH="$GARRISON_HOME/vault.json"
export GARRISON_KEYCHAIN_SERVICE="${GARRISON_KEYCHAIN_SERVICE:-agent-garrison-vault${KEYCHAIN_SUFFIX}}"
export GARRISON_KEYCHAIN_ACCOUNT="${GARRISON_KEYCHAIN_ACCOUNT:-vault-master-key${KEYCHAIN_SUFFIX}}"
export GARRISON_KANBAN_DIR="$GARRISON_HOME/kanban-loop"
export GARRISON_AUTOMATIONS_DIR="$GARRISON_HOME/automations"
export GARRISON_POLICY_PATH="$GARRISON_HOME/orchestrator/policy.json"
export GARRISON_RUNS_DIR="$GARRISON_HOME/runs"
export GARRISON_SCHEDULER_JOBS="$GARRISON_HOME/scheduler-jobs.json"
export GARRISON_SCHEDULER_LOG="$GARRISON_HOME/scheduler.log"
export GARRISON_SCHEDULER_SCRIPT="${GARRISON_SCHEDULER_SCRIPT:-$REPO_ROOT/fittings/seed/scheduler/scripts/scheduler.mjs}"
export GARRISON_TMUX_SOCKET_PATH="$GARRISON_HOME/tmux/dev-env.sock"
export CODEX_HOME="$GARRISON_HOME/runtime-homes/codex"
export GEMINI_CLI_HOME="$GARRISON_HOME/runtime-homes/gemini"
export BASIC_MEMORY_CONFIG_DIR="$GARRISON_HOME/basic-memory"
export BASIC_MEMORY_HOME="$GARRISON_HOME/basic-memory/default"
export XDG_CONFIG_HOME="$GARRISON_HOME/xdg/config"
export XDG_DATA_HOME="$GARRISON_HOME/xdg/data"
export XDG_CACHE_HOME="$GARRISON_HOME/xdg/cache"
export PLAYWRIGHT_BROWSERS_PATH="$GARRISON_HOME/playwright-browsers"
# uv TOOLS are shared, like the Claude CLI: they are binaries, not per-instance
# state, and `uv tool install` also writes a global ~/.local/bin shim — so
# projecting the tool dirs per instance only pretended to isolate them. It was
# inert in practice (no instance ever populated $GARRISON_HOME/uv; every one
# executes the shared ~/.local/share/uv install), and had it ever taken effect
# each instance would have needed its own copy of every tool while still
# fighting over the same global shim. Only the CACHE is per-instance.
export UV_CACHE_DIR="$GARRISON_HOME/uv/cache"
export UV_TOOL_DIR="${UV_TOOL_DIR:-$HOME/.local/share/uv/tools}"
export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-$HOME/.local/bin}"
export npm_config_cache="$GARRISON_HOME/npm-cache"
# node_modules/.bin so `next`/`concurrently` resolve when this script is run
# directly (bash scripts/garrison-instance.sh ...), not just via an npm script
# — systemd and the redeploy script both invoke it directly.
#
# $HOME/.local/bin and $HOME/.bun/bin carry the user-level binaries an
# interactive shell has but systemd's minimal PATH does not — notably `claude`
# itself. Without them the http-gateway verify hook fails its
# `command -v claude` check and `up` aborts, which is invisible from a shell
# where the login profile already supplied them.
export PATH="$GARRISON_HOME/bin:$UV_TOOL_BIN_DIR:$REPO_ROOT/node_modules/.bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"

# Prod builds and serves from its own dist dir so `next build` never clobbers a
# running dev server's .next (and vice versa).
if [ "$profile" = "prod" ]; then
  export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-prod}"
fi

# The host daemon sweep is a single-owner job: only prod runs it, so a dev or
# codex boot can never reap prod's fittings.
if [ "$profile" != "prod" ]; then
  export GARRISON_DISABLE_HOST_DAEMONS=1
fi

# The Claude CLI is SHARED across instances, never owned by one.
#
# Its installer writes the payload to $XDG_DATA_HOME/claude/versions/<v> but
# repoints the GLOBAL ~/.local/bin/claude at it. Because each profile isolates
# XDG_DATA_HOME, that isolation was only half-applied: whichever instance last
# ran an update captured the user's `claude` binary inside its own home, so
# resetting that instance's home would break every other instance AND the
# user's own interactive Claude Code. (Observed: the global symlink pointed
# into ~/.garrison-codex, then into ~/.garrison after a prod boot.)
#
# Pointing each instance's $XDG_DATA_HOME/claude at the shared XDG default
# makes every install land in one instance-neutral place, so the global pointer
# stays coherent no matter which profile updates. A CLI binary is not
# per-instance state; the per-instance CONFIG (CLAUDE_CONFIG_DIR) stays
# isolated above, which is the part that actually matters.
#
# Deliberately non-destructive: an existing real directory is left alone and
# reported, never silently replaced — migrating it is an explicit, manual step.
SHARED_CLAUDE_DATA="$HOME/.local/share/claude"
instance_claude_data="$XDG_DATA_HOME/claude"
if [ -L "$instance_claude_data" ]; then
  :
elif [ -d "$instance_claude_data" ]; then
  echo "[garrison] warning: $instance_claude_data is a real directory;" \
       "claude updates run here will capture the global ~/.local/bin/claude." \
       "Move it aside and symlink it to $SHARED_CLAUDE_DATA." >&2
else
  mkdir -p "$SHARED_CLAUDE_DATA" "$(dirname "$instance_claude_data")"
  ln -sfn "$SHARED_CLAUDE_DATA" "$instance_claude_data"
fi

cd "$REPO_ROOT"

scheduler_cmd="node \"$GARRISON_SCHEDULER_SCRIPT\" daemon --health-port $GARRISON_SCHEDULER_HEALTH_PORT"
outpost_cmd="node scripts/outpost-host.mjs"

case "$mode" in
  build)
    exec next build
    ;;
  start)
    if [ "$profile" = "prod" ]; then
      # Serve the built artifact, not the working tree.
      if [ ! -d "$REPO_ROOT/$NEXT_DIST_DIR" ]; then
        echo "prod: $NEXT_DIST_DIR missing — run '$0 prod build' first" >&2
        exit 1
      fi
      exec concurrently --kill-others-on-fail --names next,outpost,scheduler \
        "next start -H 127.0.0.1 -p $GARRISON_APP_PORT" \
        "$outpost_cmd" \
        "$scheduler_cmd"
    fi
    exec concurrently --kill-others-on-fail --names next,outpost,scheduler \
      "next dev -H 127.0.0.1 -p $GARRISON_APP_PORT" \
      "$outpost_cmd" \
      "$scheduler_cmd"
    ;;
  dev)
    exec concurrently --kill-others-on-fail --names next,outpost,scheduler \
      "next dev -H 127.0.0.1 -p $GARRISON_APP_PORT" \
      "$outpost_cmd" \
      "$scheduler_cmd"
    ;;
  next)
    exec next dev -H 127.0.0.1 -p "$GARRISON_APP_PORT"
    ;;
  mobile)
    exec concurrently --kill-others-on-fail --names next,outpost,scheduler \
      "next dev -H 0.0.0.0 -p $GARRISON_APP_PORT" \
      "$outpost_cmd" \
      "$scheduler_cmd"
    ;;
  env)
    for key in \
      GARRISON_INSTANCE_ID GARRISON_PORT_OFFSET \
      GARRISON_HOME GARRISON_CLAUDE_HOME CLAUDE_CONFIG_DIR \
      GARRISON_CLAUDE_JSON GARRISON_CLAUDE_CONFIG_PATH \
      GARRISON_CLAUDE_PROJECTS_DIR GARRISON_CLAUDE_SESSIONS_DIR \
      GARRISON_CLAUDE_SETTINGS_PATH GARRISON_VAULT_PATH \
      GARRISON_KEYCHAIN_SERVICE GARRISON_KEYCHAIN_ACCOUNT \
      GARRISON_KANBAN_DIR GARRISON_AUTOMATIONS_DIR \
      GARRISON_POLICY_PATH GARRISON_RUNS_DIR \
      GARRISON_SCHEDULER_JOBS GARRISON_SCHEDULER_LOG \
      GARRISON_SCHEDULER_HEALTH_PORT GARRISON_SCHEDULER_SCRIPT \
      GARRISON_TMUX_SOCKET_PATH \
      GARRISON_APP_PORT PORT \
      GARRISON_OUTPOST_PORT GARRISON_DISABLE_HOST_DAEMONS \
      NEXT_DIST_DIR \
      CODEX_HOME GEMINI_CLI_HOME \
      BASIC_MEMORY_CONFIG_DIR BASIC_MEMORY_HOME \
      XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME \
      PLAYWRIGHT_BROWSERS_PATH UV_CACHE_DIR UV_TOOL_DIR UV_TOOL_BIN_DIR \
      npm_config_cache PATH
    do
      printf '%s=%s\n' "$key" "${!key-}"
    done
    ;;
  *)
    echo "usage: $0 {prod|dev|codex} {start|dev|next|mobile|build|env}" >&2
    exit 2
    ;;
esac
