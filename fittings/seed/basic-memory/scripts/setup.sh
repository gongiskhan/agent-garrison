#!/usr/bin/env bash
# Basic Memory Fitting setup. Installs Basic Memory, registers the vault as a
# project, wires the basic-memory MCP server into Claude Code (and optionally
# Codex + Gemini), installs the lightweight session-capture hook to a stable
# location, and idempotently wires SessionEnd / PreCompact into
# ~/.claude/settings.json.
#
# Safe to re-run: every step checks current state before changing it.
set -euo pipefail

VAULT_DIR="${BASIC_MEMORY_VAULT_DIR:-$HOME/ObsidianVault}"
VAULT_DIR="${VAULT_DIR/#\~/$HOME}"
MEMORY_DIR="${BASIC_MEMORY_MEMORY_DIR:-Memory}"
PROJECT_NAME="${BASIC_MEMORY_PROJECT_NAME:-main}"
CAPTURE_ENABLED="${BASIC_MEMORY_CAPTURE_ENABLED:-true}"
REGISTER_CG="${BASIC_MEMORY_REGISTER_CODEX_GEMINI:-true}"
CLAUDE_HOME="${GARRISON_CLAUDE_HOME:-$HOME/.claude}"
SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-$CLAUDE_HOME/settings.json}"
HOOK_HOME="$CLAUDE_HOME/basic-memory"
HOOK_PATH="$HOOK_HOME/capture-session.py"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Spool drain (opt-in; composition config arrives as BASIC_MEMORY_*
# via setupConfigEnv). With the defaults everything below is a no-op and the
# stock local behavior stays byte-identical.
SPOOL_ENABLED="${BASIC_MEMORY_SPOOL_ENABLED:-false}"
SPOOL_DIR="${BASIC_MEMORY_SPOOL_DIR:-}"
FLUSH_CRON="${BASIC_MEMORY_FLUSH_INTERVAL_CRON:-*/15 * * * *}"
REMOTE_BIN="${BASIC_MEMORY_REMOTE_CLI_BIN:-cortex}"
FLUSH_PATH="$HOOK_HOME/flush-spool.mjs"
FLUSH_JOB_ID="basic-memory-spool-flush"
# Truthiness matches the hook's _truthy() (true|1|yes|on, case-insensitive) so
# an env-set "yes" cannot spool captures without also getting a drain job.
spool_on() {
  case "$(printf '%s' "$SPOOL_ENABLED" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}
quote() { printf "%q" "$1"; }

export PATH="$HOME/.local/bin:$PATH"
log() { printf '[basic-memory-setup] %s\n' "$*"; }

# 1. Required tools.
command -v uv >/dev/null 2>&1 || { echo "uv not on PATH; install uv (https://docs.astral.sh/uv/) and re-run" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not on PATH; install Python 3.10+ and re-run" >&2; exit 1; }

# 2. Install Basic Memory (idempotent - uv tool install is a no-op if current).
if command -v basic-memory >/dev/null 2>&1; then
  log "basic-memory present: $(basic-memory --version 2>/dev/null || echo '?')"
else
  log "installing basic-memory via uv tool install"
  uv tool install basic-memory
fi
BM="$(command -v basic-memory)"

# 3. Register the vault as the Basic Memory project (idempotent).
mkdir -p "$VAULT_DIR/$MEMORY_DIR"
# Existence check robust against Rich's TTY-width table collapse (grepping
# `project list` gives a false negative when piped) - `project info` exits 0 iff
# the project resolves. Matches verify.sh so setup + verify agree.
if "$BM" project info "$PROJECT_NAME" >/dev/null 2>&1; then
  # project exists - ensure it points at the vault (move is a no-op if already there)
  log "project '$PROJECT_NAME' exists - ensuring -> $VAULT_DIR"
  "$BM" project move "$PROJECT_NAME" "$VAULT_DIR" >/dev/null 2>&1 || true
else
  log "adding project '$PROJECT_NAME' -> $VAULT_DIR"
  "$BM" project add "$PROJECT_NAME" "$VAULT_DIR" >/dev/null 2>&1 || \
    "$BM" project move "$PROJECT_NAME" "$VAULT_DIR" >/dev/null 2>&1 || true
fi
"$BM" project default "$PROJECT_NAME" >/dev/null 2>&1 || true

# 4. Register the MCP server with Claude Code (user scope, idempotent).
if command -v claude >/dev/null 2>&1; then
  if claude mcp get basic-memory >/dev/null 2>&1; then
    log "claude mcp 'basic-memory' already registered"
  else
    log "registering basic-memory MCP with Claude Code"
    claude mcp add -s user basic-memory -- "$BM" mcp >/dev/null 2>&1 || true
  fi
else
  log "claude CLI not on PATH; skipping Claude MCP registration"
fi

# 5. Register the MCP server with Codex + Gemini (idempotent, soft-fail).
if [ "$REGISTER_CG" = "true" ]; then
  if command -v codex >/dev/null 2>&1; then
    if codex mcp get basic-memory >/dev/null 2>&1; then
      log "codex mcp 'basic-memory' already registered"
    else
      log "registering basic-memory MCP with Codex"
      codex mcp add basic-memory -- "$BM" mcp >/dev/null 2>&1 || log "codex mcp add failed (non-fatal)"
    fi
  fi
  if command -v gemini >/dev/null 2>&1; then
    if gemini mcp list 2>/dev/null | grep -q basic-memory; then
      log "gemini mcp 'basic-memory' already registered"
    else
      log "registering basic-memory MCP with Gemini"
      gemini mcp add -s user basic-memory "$BM" mcp >/dev/null 2>&1 || log "gemini mcp add failed (non-fatal)"
    fi
  fi
fi

# 6. Install the capture hook to a stable location + wire it (idempotent).
if [ "$CAPTURE_ENABLED" = "true" ]; then
  mkdir -p "$HOOK_HOME"
  cp "$SCRIPT_DIR/capture-session.py" "$HOOK_PATH"
  chmod +x "$HOOK_PATH"

  mkdir -p "$(dirname "$SETTINGS_FILE")"
  [ -f "$SETTINGS_FILE" ] || echo '{}' > "$SETTINGS_FILE"

  # When the spool is on, bake its env into the hook command so both the
  # spool copy and the hook's detached fire-and-forget flush see it. When it
  # is off (the default) SPOOL_ENV is empty and CAP_CMD is byte-identical to
  # the historical command.
  SPOOL_ENV=""
  if spool_on; then
    # %q-quoted (like the scheduler path below): a config value carrying
    # quotes/$() must land as data in the hook command, never as shell.
    SPOOL_ENV="BASIC_MEMORY_SPOOL_ENABLED=1 REMOTE_MEMORY_CLI_BIN=$(quote "$REMOTE_BIN") "
    [ -n "$SPOOL_DIR" ] && SPOOL_ENV="${SPOOL_ENV}BASIC_MEMORY_SPOOL_DIR=$(quote "$SPOOL_DIR") "
  fi
  CAP_CMD="${SPOOL_ENV}BASIC_MEMORY_VAULT_DIR=\"$VAULT_DIR\" BASIC_MEMORY_MEMORY_DIR=\"$MEMORY_DIR\" python3 \"$HOOK_PATH\""
  python3 - "$SETTINGS_FILE" "$CAP_CMD" <<'PY'
import json, sys
from pathlib import Path
sp = Path(sys.argv[1]); cmd = sys.argv[2]
data = json.loads(sp.read_text() or "{}")
hooks = data.setdefault("hooks", {})
added = []
for event in ("SessionEnd", "PreCompact"):
    bucket = hooks.setdefault(event, [])
    found = False
    for e in bucket:
        for h in e.get("hooks", []):
            if "basic-memory/capture-session.py" in h.get("command",""):
                found = True
                # Config changed (e.g. spool toggled): refresh the command
                # in place instead of stacking a duplicate registration.
                if h.get("command") != cmd:
                    h["command"] = cmd
                    added.append(event + " (updated)")
    if found:
        continue
    bucket.append({"matcher": "", "hooks": [{"type": "command", "command": cmd, "timeout": 10}]})
    added.append(event)
sp.write_text(json.dumps(data, indent=2) + "\n")
print("[basic-memory-setup] capture hook wired: " + (", ".join(added) if added else "already wired"))
PY
else
  log "capture hook disabled (capture_enabled=false)"
fi

# 7. Spool drain job (opt-in). Mirrors the improver-nightly scheduler idiom:
# state is machine-global (~/.garrison per instance) - scheduler.mjs derives
# its own GARRISON_HOME defaults, so we only pass overrides that are set.
# Installed layout puts this script at
# <composition>/apm_modules/_local/basic-memory/scripts, hence the ../../..;
# outside a composition the scheduler is simply absent and we skip.
composition_dir="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
scheduler_script="$composition_dir/apm_modules/_local/scheduler/scripts/scheduler.mjs"
jobs_file="${GARRISON_SCHEDULER_JOBS:-}"
log_file="${GARRISON_SCHEDULER_LOG:-}"
sched_env=()
[ -n "$jobs_file" ] && sched_env+=("GARRISON_SCHEDULER_JOBS=$jobs_file")
[ -n "$log_file" ] && sched_env+=("GARRISON_SCHEDULER_LOG=$log_file")
sched() { env ${sched_env[@]+"${sched_env[@]}"} node "$scheduler_script" "$@"; }

if spool_on; then
  # The drain must survive composition churn like the hook does, so it runs
  # from the same stable install dir ($CLAUDE_HOME/basic-memory).
  mkdir -p "$HOOK_HOME"
  cp "$SCRIPT_DIR/flush-spool.mjs" "$FLUSH_PATH"

  if [ ! -f "$scheduler_script" ]; then
    log "scheduler not installed; spool flush job not registered"
  else
    job_env="REMOTE_MEMORY_CLI_BIN=$(quote "$REMOTE_BIN")"
    [ -n "$SPOOL_DIR" ] && job_env="$job_env BASIC_MEMORY_SPOOL_DIR=$(quote "$SPOOL_DIR")"
    sched register "$FLUSH_JOB_ID" "$FLUSH_CRON" \
      --description "Drain the basic-memory capture spool via the remote memory CLI" \
      -- "$job_env node $(quote "$FLUSH_PATH")"
    log "spool flush job registered ($FLUSH_JOB_ID: $FLUSH_CRON)"
  fi
else
  # Spool off (the default): retire our drain job if a previous enable left
  # one behind. Gated on the job actually existing (improver-nightly's
  # conditional idiom) - scheduler.mjs `remove` rewrites the machine-global
  # jobs file even for a no-op, and the default-off path must touch nothing.
  if [ -f "$scheduler_script" ] && sched list 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      let jobs = [];
      try { jobs = JSON.parse(raw).jobs ?? []; } catch { process.exit(1); }
      process.exit(jobs.some((j) => j?.id === "basic-memory-spool-flush") ? 0 : 1);
    });
  '; then
    sched remove "$FLUSH_JOB_ID" >/dev/null 2>&1 || true
  fi
fi

log "basic-memory setup ok"
