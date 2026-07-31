#!/usr/bin/env bash
# Basic Memory Fitting setup. Installs Basic Memory, registers the vault as a
# project, wires the basic-memory MCP server into Claude Code (and optionally
# Codex + Gemini), installs the lightweight session-capture hook to a stable
# location, and idempotently wires SessionEnd / PreCompact into
# ~/.claude/settings.json.
#
# Two backends (config key `backend`, default `local`):
#   local  - everything above, unchanged. The whole fitting works on a fresh
#            clone with an empty vault and reaches nothing off the machine.
#   cortex - memory of record lives in a remote note vault. The local capture
#            keeps running (it is the spool's source), but the local MCP server
#            is NOT registered and the operative is taught the remote memory CLI
#            instead, via the skill variant under skill-variants/.
# The local path must stay byte-identical to the pre-switch fitting, so every
# cortex-only branch below is explicitly gated and every cleanup is conditional
# on the artifact actually being there.
#
# Safe to re-run: every step checks current state before changing it, and a
# backend flip in either direction cleans up the other backend's artifacts.
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

# Spool drain (composition config arrives as BASIC_MEMORY_* via
# setupConfigEnv). With the defaults everything below is a no-op and the stock
# local behavior stays byte-identical.
SPOOL_ENABLED="${BASIC_MEMORY_SPOOL_ENABLED:-auto}"
SPOOL_DIR="${BASIC_MEMORY_SPOOL_DIR:-}"
FLUSH_CRON="${BASIC_MEMORY_FLUSH_INTERVAL_CRON:-*/15 * * * *}"
REMOTE_BIN="${BASIC_MEMORY_REMOTE_CLI_BIN:-cortex}"
FLUSH_PATH="$HOOK_HOME/flush-spool.mjs"
FLUSH_JOB_ID="basic-memory-spool-flush"
BACKEND="${BASIC_MEMORY_BACKEND:-local}"

# Shadow dual-write and its comparator - the rule-10 migration half. Default
# OFF: with `shadow_write` absent nothing below runs and the fitting is exactly
# what the backend-switch slice shipped. The dual-write marker is machine-global
# (under GARRISON_HOME, beside the spool) because the review deadline belongs to
# the machine that started dual-writing, not to one composition.
SHADOW_WRITE="${BASIC_MEMORY_SHADOW_WRITE:-false}"
REMOTE_FOLDER="${BASIC_MEMORY_REMOTE_FOLDER:-vault}"
COMPARE_CRON="${BASIC_MEMORY_COMPARE_CRON:-27 4 * * *}"
COMPARE_SAMPLE="${BASIC_MEMORY_COMPARE_SAMPLE_SIZE:-5}"
GARRISON_ROOT="${GARRISON_HOME:-$HOME/.garrison}"
STATE_DIR="$GARRISON_ROOT/basic-memory"
SHADOW_MARKER="$STATE_DIR/shadow-write.json"
COMPARE_PATH="$HOOK_HOME/compare-backends.mjs"
IMPORT_PATH="$HOOK_HOME/import-vault.mjs"
COMPARE_JOB_ID="basic-memory-backend-compare"
# NOT configurable, on purpose: a knob that moves the deadline is the "flag that
# becomes furniture" this shape exists to prevent. Extending is a review outcome
# with a written reason, not a config value.
REVIEW_WINDOW_DAYS=14
quote() { printf "%q" "$1"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Where the two skill variants live, and where the installed one goes. The
# installed layout is <composition>/apm_modules/_local/basic-memory/scripts, so
# the composition dir is four levels up; APM installs .apm/skills/<name>/ into
# <composition>/.claude/skills/<name>/, and that is the file we swap.
SCRIPT_DIR_PARENT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODULES_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSITION_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
SKILL_LOCAL_SRC="$SCRIPT_DIR_PARENT/.apm/skills/garrison-memory/SKILL.md"
SKILL_CORTEX_SRC="$SCRIPT_DIR_PARENT/skill-variants/cortex/SKILL.md"
SKILL_DEST="$COMPOSITION_DIR/.claude/skills/garrison-memory/SKILL.md"
# Marks an installed SKILL.md as OURS (a remote-backend variant we wrote), so a
# flip back to local restores only what this fitting put there and never a
# hand-authored or reconciled file.
SKILL_REMOTE_MARK="garrison-memory-backend: cortex"

export PATH="$HOME/.local/bin:$PATH"
log() { printf '[basic-memory-setup] %s\n' "$*"; }

# --- backend + spool precedence -------------------------------------------
# backend: unknown values fall back to the shipped default rather than failing
# the composition - an unrecognised backend is a config typo, not a reason to
# leave the operative with no memory at all.
case "$(lower "$BACKEND")" in
  ""|local) BACKEND="local" ;;
  cortex) BACKEND="cortex" ;;
  *) log "unknown backend '$BACKEND'; falling back to local"; BACKEND="local" ;;
esac

# shadow_write: a plain boolean, default false. On means "keep writing the LOCAL
# vault exactly as today AND enqueue the same capture for the remote store" -
# shadow ADDS a destination, it never replaces one. Unknown values read as the
# shipped default (off), like `backend` does.
case "$(lower "$SHADOW_WRITE")" in
  1|true|yes|on) SHADOW_ON=1 ;;
  ""|0|false|no|off) SHADOW_ON=0 ;;
  *) log "unknown shadow_write '$SHADOW_WRITE'; falling back to false"; SHADOW_ON=0 ;;
esac
shadow_on() { [ "$SHADOW_ON" = "1" ]; }

# spool: `auto` follows the backend AND the shadow (off on plain local, on for a
# remote backend - a remote backend that never drains is a silent no-op - and on
# under shadow, because the spool IS how a shadow capture reaches the remote
# store); `always`/`never` override it in either direction. Legacy booleans from
# the pre-switch config are read as the corresponding explicit choice.
#
# PRECEDENCE, in one line: explicit spool_enabled > (backend remote OR
# shadow_write) > off.
if [ "$BACKEND" = "cortex" ] || shadow_on; then SPOOL_AUTO=1; else SPOOL_AUTO=0; fi
case "$(lower "$SPOOL_ENABLED")" in
  always|1|true|yes|on) SPOOL_ON=1 ;;
  never|0|false|no|off) SPOOL_ON=0 ;;
  ""|auto) SPOOL_ON="$SPOOL_AUTO" ;;
  *)
    log "unknown spool_enabled '$SPOOL_ENABLED'; treating as auto"
    SPOOL_ON="$SPOOL_AUTO"
    ;;
esac
spool_on() { [ "$SPOOL_ON" = "1" ]; }

# The one combination that cannot do what it says. `never` is an explicit
# opt-out and keeps beating an implicit switch, so it wins - but a shadow with
# nothing to enqueue into is inert, and a silent inert shadow is exactly the
# kind of furniture rule 10 exists to prevent. Say so, loudly, every run.
if shadow_on && ! spool_on; then
  log "warning: shadow_write=true but spool_enabled=never - NO capture is enqueued for the remote store; the shadow is INERT until spool_enabled is auto or always"
fi

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

# 4-5. MCP registration. Only the local backend hands the agents the upstream
# basic-memory MCP server; on a remote backend the ops surface is the remote
# CLI, and leaving the local server registered would offer the operative two
# memories with no way to tell which one is authoritative.
if [ "$BACKEND" = "local" ]; then
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
else
  # Remote backend: skip registration, and retire a registration a previous
  # local run left behind. Conditional on it actually existing, so a machine
  # that was never on the local backend is untouched.
  log "backend=$BACKEND: not registering the basic-memory MCP server"
  if command -v claude >/dev/null 2>&1 && claude mcp get basic-memory >/dev/null 2>&1; then
    log "retiring the basic-memory MCP registration from Claude Code"
    claude mcp remove -s user basic-memory >/dev/null 2>&1 || log "claude mcp remove failed (non-fatal)"
  fi
  if command -v codex >/dev/null 2>&1 && codex mcp get basic-memory >/dev/null 2>&1; then
    log "retiring the basic-memory MCP registration from Codex"
    codex mcp remove basic-memory >/dev/null 2>&1 || log "codex mcp remove failed (non-fatal)"
  fi
  if command -v gemini >/dev/null 2>&1 && gemini mcp list 2>/dev/null | grep -q basic-memory; then
    log "retiring the basic-memory MCP registration from Gemini"
    gemini mcp remove basic-memory >/dev/null 2>&1 || log "gemini mcp remove failed (non-fatal)"
  fi
fi

# 5b. Install the skill variant that matches the backend, so the operative is
# taught the ops surface that actually exists in its session. APM already
# installed the local variant from .apm/skills/, so the DEFAULT path writes
# nothing at all; the remote path overwrites that copy and a flip back restores
# it - but only when the installed file is one WE wrote (it carries the marker),
# never a hand-edited or reconciled file.
if [ "$(basename "$MODULES_DIR")" != "apm_modules" ]; then
  log "not running from an installed composition; skill variant left alone"
elif [ "$BACKEND" != "local" ]; then
  if [ ! -f "$SKILL_CORTEX_SRC" ]; then
    echo "backend=$BACKEND but the skill variant is missing at $SKILL_CORTEX_SRC" >&2
    exit 1
  fi
  if cmp -s "$SKILL_CORTEX_SRC" "$SKILL_DEST"; then
    log "skill variant already installed for backend=$BACKEND"
  else
    mkdir -p "$(dirname "$SKILL_DEST")"
    cp -f "$SKILL_CORTEX_SRC" "$SKILL_DEST"
    log "installed the $BACKEND skill variant -> $SKILL_DEST"
  fi
elif [ -f "$SKILL_DEST" ] && grep -q "$SKILL_REMOTE_MARK" "$SKILL_DEST" 2>/dev/null; then
  if [ -f "$SKILL_LOCAL_SRC" ]; then
    cp -f "$SKILL_LOCAL_SRC" "$SKILL_DEST"
    log "backend=local: restored the local skill variant"
  else
    rm -f "$SKILL_DEST"
    log "backend=local: removed the stale remote skill variant (no local source to restore)"
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

# 7. Spool drain job. Registered exactly when spooling resolved to on above
# (never on the default local+auto path), retired when it resolved to off.
# Mirrors the improver-nightly scheduler idiom: state is machine-global
# (~/.garrison per instance) - scheduler.mjs derives its own GARRISON_HOME
# defaults, so we only pass overrides that are set. Outside an installed
# composition the scheduler is simply absent and we skip.
scheduler_script="$COMPOSITION_DIR/apm_modules/_local/scheduler/scripts/scheduler.mjs"
jobs_file="${GARRISON_SCHEDULER_JOBS:-}"
log_file="${GARRISON_SCHEDULER_LOG:-}"
sched_env=()
[ -n "$jobs_file" ] && sched_env+=("GARRISON_SCHEDULER_JOBS=$jobs_file")
[ -n "$log_file" ] && sched_env+=("GARRISON_SCHEDULER_LOG=$log_file")
sched() { env ${sched_env[@]+"${sched_env[@]}"} node "$scheduler_script" "$@"; }

# Is a job of ours already in the machine-global jobs file? Used to gate every
# `remove` (improver-nightly's conditional idiom): scheduler.mjs `remove`
# rewrites the jobs file even for a no-op, and the default-off path must touch
# nothing at all. The listing goes through a TEMP FILE rather than a pipe, so
# the exit code being tested is unambiguously this check's own.
job_registered() {
  [ -f "$scheduler_script" ] || return 1
  local wanted="$1" listing rc
  listing="$(mktemp)"
  if ! sched list >"$listing" 2>/dev/null; then
    rm -f "$listing"
    return 1
  fi
  if SCHED_LISTING="$listing" SCHED_WANTED_ID="$wanted" node -e '
    const fs = require("node:fs");
    let jobs = [];
    try { jobs = JSON.parse(fs.readFileSync(process.env.SCHED_LISTING, "utf8")).jobs ?? []; }
    catch { process.exit(1); }
    process.exit(jobs.some((j) => j?.id === process.env.SCHED_WANTED_ID) ? 0 : 1);
  '; then rc=0; else rc=1; fi
  rm -f "$listing"
  return "$rc"
}

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
  # Spool off (the default, and what a flip back to local resolves to): retire
  # our drain job if a previous enable left one behind.
  if job_registered "$FLUSH_JOB_ID"; then
    sched remove "$FLUSH_JOB_ID" >/dev/null 2>&1 || true
  fi
fi

# 8. Shadow dual-write: the marker that fixes the review date, and the daily
# comparator. Gated on shadow_write; nothing here runs on the default path.
#
# The marker is written ONCE, the first time shadow resolves on, and is then
# left alone - including when shadow goes off again. That is the point: rule 10
# fixes the review date UP FRONT, so it must not be resettable by toggling a
# config key. Deleting the marker by hand is how you close a dual-write period
# (cut over, or remove), and starting a new period is a deliberate act.
if shadow_on; then
  mkdir -p "$STATE_DIR"
  if [ -f "$SHADOW_MARKER" ]; then
    log "shadow dual-write already recorded in $SHADOW_MARKER (review date unchanged)"
  else
    REVIEW_WINDOW_DAYS="$REVIEW_WINDOW_DAYS" python3 - "$SHADOW_MARKER" <<'PY'
import datetime, json, os, sys
days = int(os.environ.get("REVIEW_WINDOW_DAYS") or 14)
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
due = now + datetime.timedelta(days=days)
iso = lambda t: t.isoformat().replace("+00:00", "Z")
with open(sys.argv[1], "w") as fh:
    json.dump({
        "first_dual_write_at": iso(now),
        "review_window_days": days,
        "review_due_at": iso(due),
        "note": (
            "Shadow dual-write is a migration, not a mode. On or before review_due_at, "
            "choose ONE: cut reads over, extend ONCE with a written reason, or remove. "
            "Record the choice in docs/DECISIONS.md. This file is deliberately not reset "
            "by toggling shadow_write; delete it by hand to close the period."
        )
    }, fh, indent=2)
    fh.write("\n")
print("[basic-memory-setup] dual-write marker written: " + sys.argv[1])
PY
  fi

  # The comparator (and the one-time importer, for convenience) run from the
  # same stable install dir as the hook and the drain, so they survive
  # composition churn. The shared lib travels with them.
  mkdir -p "$HOOK_HOME/lib"
  cp "$SCRIPT_DIR/compare-backends.mjs" "$COMPARE_PATH"
  cp "$SCRIPT_DIR/import-vault.mjs" "$IMPORT_PATH"
  cp "$SCRIPT_DIR/lib/memory-vault.mjs" "$HOOK_HOME/lib/memory-vault.mjs"
  log "one-time vault import available: node $IMPORT_PATH --dry-run"

  if [ ! -f "$scheduler_script" ]; then
    log "scheduler not installed; backend comparison job not registered"
  else
    # The daemon has no idea which composition registered the job, so every
    # path the comparator needs is baked in %q-quoted (data, never shell):
    # where the vault is, which remote folder holds the imported notes, where
    # the dated report goes, and which GARRISON_HOME holds the marker + the
    # CLI install receipt.
    cmp_env="REMOTE_MEMORY_CLI_BIN=$(quote "$REMOTE_BIN")"
    cmp_env="$cmp_env GARRISON_HOME=$(quote "$GARRISON_ROOT")"
    cmp_env="$cmp_env BASIC_MEMORY_VAULT_DIR=$(quote "$VAULT_DIR")"
    cmp_env="$cmp_env BASIC_MEMORY_MEMORY_DIR=$(quote "$MEMORY_DIR")"
    cmp_env="$cmp_env BASIC_MEMORY_REMOTE_FOLDER=$(quote "$REMOTE_FOLDER")"
    cmp_env="$cmp_env BASIC_MEMORY_COMPARE_SAMPLE_SIZE=$(quote "$COMPARE_SAMPLE")"
    cmp_env="$cmp_env BASIC_MEMORY_COMPARE_REPORT_DIR=$(quote "$COMPOSITION_DIR/data/memory-backend-compare")"
    sched register "$COMPARE_JOB_ID" "$COMPARE_CRON" \
      --description "Compare the local memory vault against the remote store and file a dated diff report" \
      -- "$cmp_env node $(quote "$COMPARE_PATH")"
    log "backend comparison job registered ($COMPARE_JOB_ID: $COMPARE_CRON)"
  fi
else
  # Shadow off (the default): retire the comparator if a previous enable left
  # one behind. The MARKER is deliberately NOT removed here - see above.
  if job_registered "$COMPARE_JOB_ID"; then
    sched remove "$COMPARE_JOB_ID" >/dev/null 2>&1 || true
  fi
fi

log "basic-memory setup ok"
