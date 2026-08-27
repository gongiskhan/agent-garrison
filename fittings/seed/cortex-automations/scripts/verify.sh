#!/usr/bin/env bash
# cortex-automations verify (READ-ONLY) - prints "ok".
#
# This Fitting owns no process, no port and no state: it is a view plus the usage
# knowledge over a capability CLI that a DIFFERENT Fitting installs. So verify has
# exactly two jobs: prove this Fitting's own payload travelled, and report - truthfully -
# whether the remote runner is reachable-in-principle from this machine.
#
# THREE OUTCOMES, and the difference between the first two is the whole point:
#
#   1. NOT INSTALLED -> ok. No install receipt and no binary on PATH means no CLI was ever
#      asked for. That is the SHIPPED DEFAULT (CAPABILITY_CONTRACT rule 6): a fresh clone
#      with an empty vault must compose and run, and this Fitting is simply inert - the
#      skill tells the agent to say so and stop, which is a supported answer, not a fault.
#   2. INSTALLED BUT BROKEN -> fail. An install receipt is this machine stating that it
#      installed a CLI on purpose. Held to account: the binary it names must exist, run, and
#      expose the `automations` group. A receipt pointing at something that cannot run is a
#      broken install, and reporting it green would hand the operative a capability that
#      dies on first use.
#   3. INSTALLED AND USABLE -> ok, naming how it was resolved.
#
# DEGRADED-OK: a missing CORTEX_API_KEY is never a failure here. `automations --help` is
# answered with no configuration at all, so the install is provable without a credential;
# whether a key is provisioned is REPORTED, never gated on. The key's value is never read,
# never printed, never logged - and there is no `set -x` anywhere in this file.
#
# NOTE on env: runner.verify() hands verify hooks only the gateway hook env (plus the
# composition's .env), and does NOT project this Fitting's config env. So nothing here may
# depend on a config variable arriving - the install receipt is the lookup table, and it is
# read from disk.
#
# Read-only: no clone, no fetch, no install, no write, not even to the state dir.
set -uo pipefail

FIT="cortex-automations"
SKILL_NAME="cortex-automations"
# The receipt is written by the CLI-installing Fitting; this one only ever reads it.
CLIENT_FIT="cortex-client"
DEFAULT_BIN_NAME="cortex"

GH="${GARRISON_HOME:-$HOME/.garrison}"
RECEIPT="$GH/$CLIENT_FIT/install.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FITTING_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_FILE="$FITTING_DIR/.apm/skills/$SKILL_NAME/SKILL.md"

fail() { echo "verify-failed: $*"; exit 1; }

# ---------------------------------------------------------------------------
# 1) This Fitting's own payload. The skill IS the deliverable - a manifest that
#    installs without it stations a view that teaches the operative nothing.
#    Resolved from this script's own location, so it holds both in the repo and
#    under apm_modules/_local/<id>/.
# ---------------------------------------------------------------------------
[ -f "$SKILL_FILE" ] || fail "the skill payload is missing at $SKILL_FILE"

# ---------------------------------------------------------------------------
# 2) Resolve the binary, in the documented order: the receipt first, the bin name
#    on PATH only as a fallback. Never a hardcoded clone path.
# ---------------------------------------------------------------------------
receipt_field() {
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(doc[process.argv[2]] ?? ""));
    } catch { /* an unreadable receipt falls through to the PATH fallback below */ }
  ' "$RECEIPT" "$1" 2>/dev/null
}

# Runs the one invocation that needs NO provider configuration and still proves the
# automations surface exists. Not a pipe: the exit status is captured on its own line,
# straight after the assignment, so it is the CLI's status and not some pipeline's.
probe() {
  local candidate="$1"
  local out rc
  out="$(env -u CORTEX_API_KEY -u CORTEX_BASE_URL "$candidate" automations --help 2>/dev/null)"
  rc=$?
  [ "$rc" -eq 0 ] || return 1
  [ -n "$out" ] || return 1
  return 0
}

BIN=""
BIN_SOURCE=""
BIN_NAME="$DEFAULT_BIN_NAME"

if [ -f "$RECEIPT" ]; then
  command -v node >/dev/null 2>&1 || fail "node is not on PATH but an install is recorded at $RECEIPT"

  RECEIPT_BIN="$(receipt_field bin)"
  RECEIPT_BIN_NAME="$(receipt_field bin_name)"
  [ -n "$RECEIPT_BIN_NAME" ] && BIN_NAME="$RECEIPT_BIN_NAME"

  if [ -n "$RECEIPT_BIN" ] && [ -x "$RECEIPT_BIN" ]; then
    BIN="$RECEIPT_BIN"
    BIN_SOURCE="install receipt"
  else
    # The receipt exists but does not lead anywhere runnable. Fall back to the bin
    # name on PATH before giving up - the link may have moved while the binary is
    # still perfectly reachable.
    FALLBACK="$(command -v "$BIN_NAME" 2>/dev/null || true)"
    if [ -n "$FALLBACK" ]; then
      BIN="$FALLBACK"
      BIN_SOURCE="PATH (the receipt's bin path is not runnable)"
    else
      fail "an install is recorded at $RECEIPT but no runnable '$BIN_NAME' was found (re-run the CLI Fitting's setup)"
    fi
  fi

  probe "$BIN" ||
    fail "'$BIN_NAME automations --help' did not succeed at $BIN - the CLI is installed but broken or too old to expose automations (re-run the CLI Fitting's setup)"

  echo "[$FIT] remote automations reachable through $BIN (resolved from the $BIN_SOURCE)"
else
  # No receipt: nothing on this machine claims to have installed a CLI. PATH is a
  # courtesy lookup here and REPORTS only - it never gates. A stranger binary that
  # happens to share the name is not this Fitting's install, and failing a whole
  # composition over one would be a false alarm.
  FALLBACK="$(command -v "$DEFAULT_BIN_NAME" 2>/dev/null || true)"
  if [ -z "$FALLBACK" ]; then
    echo "[$FIT] no install receipt at $RECEIPT and no '$DEFAULT_BIN_NAME' on PATH - the capability CLI is not installed (shipped default; the skill tells the agent to say so and stop)"
  elif probe "$FALLBACK"; then
    echo "[$FIT] no install receipt, but a usable '$DEFAULT_BIN_NAME' is on PATH at $FALLBACK"
  else
    echo "[$FIT] no install receipt; '$DEFAULT_BIN_NAME' on PATH at $FALLBACK does not answer 'automations --help' - treating the capability as not installed (not a failure: nothing here claimed to install it)"
  fi
fi

# ---------------------------------------------------------------------------
# 3) Credential status only - presence, never the value, never a prefix of it.
# ---------------------------------------------------------------------------
if [ -n "${CORTEX_API_KEY:-}" ]; then
  echo "[$FIT] CORTEX_API_KEY: provisioned"
else
  echo "[$FIT] CORTEX_API_KEY: absent - runs cannot be started until it is sealed in the Vault (not a failure)"
fi

echo "ok"
