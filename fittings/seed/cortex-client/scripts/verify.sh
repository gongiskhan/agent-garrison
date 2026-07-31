#!/usr/bin/env bash
# cortex-client verify (READ-ONLY) — prints "ok".
#
# Two legitimate green states, and the difference matters:
#
#   1. NOT CONFIGURED. No install receipt, so no CLI was ever asked for. That is the
#      shipped default (CAPABILITY_CONTRACT rule 6) and it verifies green — a fresh
#      clone with an empty vault must compose and run.
#   2. INSTALLED. The clone is where the receipt says, still OUTSIDE Garrison's MIT
#      tree, still at the recorded pin, the binary is linked, and it RUNS.
#
# DEGRADED-OK: a missing CORTEX_API_KEY is never a failure here. The binary's
# no-configuration commands (`--version`, `--help`) work without one, so the install
# is provable without a credential; whether a key is provisioned is reported, never
# gated on. The key's VALUE is never read, printed or logged.
#
# Read-only: no clone, no fetch, no checkout, no write. Setup does all of that.
set -uo pipefail

FIT="cortex-client"
GH="${GARRISON_HOME:-$HOME/.garrison}"
RECEIPT="$GH/$FIT/install.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "verify-failed: $*"; exit 1; }

if [ ! -f "$RECEIPT" ]; then
  echo "[$FIT] no install receipt — the CLI is not configured (shipped default; consumers no-op)"
  echo "ok"
  exit 0
fi

command -v node >/dev/null 2>&1 || fail "node is not on PATH but an install is recorded at $RECEIPT"

receipt_field() {
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(doc[process.argv[2]] ?? ""));
    } catch { /* fall through to the empty-field failures below */ }
  ' "$RECEIPT" "$1" 2>/dev/null
}

BIN="$(receipt_field bin)"
CLONE="$(receipt_field clone)"
REF="$(receipt_field ref)"
BIN_NAME="$(receipt_field bin_name)"

[ -n "$BIN" ] || fail "install receipt $RECEIPT has no bin path"
[ -n "$CLONE" ] || fail "install receipt $RECEIPT has no clone path"
[ -n "$REF" ] || fail "install receipt $RECEIPT records no pin"

# License isolation, re-checked read-only: third-party bytes must still be outside
# Garrison's own tree. A hand-moved clone is a finding, not a warning.
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$REPO_ROOT" ]; then
  case "$CLONE/" in
    "$REPO_ROOT"/*) fail "clone $CLONE is INSIDE Garrison's own source tree ($REPO_ROOT)" ;;
  esac
fi
case "$CLONE" in
  */dev/garrison/*|*/Projects/garrison/*) fail "clone $CLONE matches a Garrison source path" ;;
esac

[ -d "$CLONE/.git" ] || fail "clone missing at $CLONE (re-run setup)"

command -v git >/dev/null 2>&1 || fail "git is not on PATH but a clone is recorded at $CLONE"
HEAD_SHA="$(git -C "$CLONE" rev-parse HEAD 2>/dev/null)" || fail "could not read HEAD in $CLONE"
case "$HEAD_SHA" in
  "$REF"*) : ;;
  *) fail "pin drift: $CLONE is at $HEAD_SHA but the receipt records $REF (re-run setup)" ;;
esac

[ -L "$BIN" ] || fail "$BIN is not a symlink to the built CLI (re-run setup)"
[ -e "$BIN" ] || fail "$BIN is a broken symlink (the clone moved or was cleaned; re-run setup)"

# The binary must run with NO provider configuration at all. This is the whole
# degraded-ok claim: strip both variables, then require exit 0.
VERSION_OUT=""
if ! VERSION_OUT="$(env -u CORTEX_API_KEY -u CORTEX_BASE_URL "$BIN" --version 2>/dev/null)"; then
  fail "'${BIN_NAME:-cortex} --version' did not exit 0 — the clone is not built (re-run setup)"
fi
[ -n "$VERSION_OUT" ] || fail "'${BIN_NAME:-cortex} --version' printed nothing"

echo "[$FIT] ${BIN_NAME:-cortex} $VERSION_OUT at $BIN (pin $HEAD_SHA)"

# Credential status only — presence, never the value, never a prefix of it.
if [ -n "${CORTEX_API_KEY:-}" ]; then
  echo "[$FIT] CORTEX_API_KEY: provisioned"
else
  echo "[$FIT] CORTEX_API_KEY: absent — the CLI is installed but cannot call the provider yet (not a failure)"
fi

echo "ok"
