#!/usr/bin/env bash
# cortex-client verify (READ-ONLY) — prints "ok".
#
# Three states, and telling them apart is the whole job:
#
#   1. NOT CONFIGURED — no receipt and no failure marker, so no CLI was ever asked
#      for. That is the shipped default (CAPABILITY_CONTRACT rule 6) and it is
#      green: a fresh clone with an empty vault must compose and run.
#   2. INSTALL FAILED — setup ran, wrote a failure marker and no receipt. NOT the
#      same as state 1 and it must never read as green: the runner's pre-verify
#      setup pass catches a setup failure and CONTINUES, so without the marker a
#      half-cloned box would verify "ok".
#   3. INSTALLED — the clone is where the receipt says, still outside Garrison's
#      tree, still at exactly the recorded pin, the published binary still points
#      into the clone, and it RUNS.
#
# The isolation checks and the run probe come from lib/common.sh, the same file
# setup.sh uses. That is deliberate: when the two carried their own copies, setup
# accepted a binary verify could not execute and then blamed the build for it.
#
# DEGRADED-OK: a missing CORTEX_API_KEY is never a failure here. The binary's
# no-configuration commands work without one, so the install is provable without a
# credential; whether a key is provisioned is reported, never gated on. The key's
# VALUE is never read, printed or logged.
#
# Read-only: no clone, no fetch, no checkout, no write.
set -uo pipefail
set +x
unset BASH_XTRACEFD 2>/dev/null || true
unset SHELLOPTS 2>/dev/null || true

FIT="cortex-client"
GH="${GARRISON_HOME:-$HOME/.garrison}"
STATE="$GH/$FIT"
RECEIPT="$STATE/install.json"
MARKER="$STATE/install-failed.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "verify-failed: $*"; exit 1; }
# lib/common.sh signals a refusal by calling die(); here a refusal is a failure.
die() { fail "$*"; }

# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

json_field() {
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(doc[process.argv[2]] ?? ""));
    } catch { /* fall through to the empty-field failures below */ }
  ' "$1" "$2" 2>/dev/null
}

# State 2 first: a failed install must not be readable as "never configured".
if [ -f "$MARKER" ]; then
  REASON=""
  if command -v node >/dev/null 2>&1; then
    REASON="$(json_field "$MARKER" reason)"
  fi
  fail "setup failed and left the install incomplete${REASON:+ ($REASON)} — fix the cause and re-run setup"
fi

# State 1.
if [ ! -f "$RECEIPT" ]; then
  echo "[$FIT] no install receipt — the CLI is not configured (shipped default; consumers no-op)"
  echo "ok"
  exit 0
fi

# State 3.
command -v node >/dev/null 2>&1 || fail "node is not on PATH but an install is recorded at $RECEIPT"
command -v git >/dev/null 2>&1 || fail "git is not on PATH but an install is recorded at $RECEIPT"

BIN="$(json_field "$RECEIPT" bin)"
CLONE="$(json_field "$RECEIPT" clone)"
REF="$(json_field "$RECEIPT" ref)"
BIN_NAME="$(json_field "$RECEIPT" bin_name)"

[ -n "$BIN" ] || fail "install receipt $RECEIPT has no bin path"
[ -n "$CLONE" ] || fail "install receipt $RECEIPT has no clone path"
[ -n "$REF" ] || fail "install receipt $RECEIPT records no pin"

# Byte containment, re-checked read-only — on the clone AND on what the published
# binary actually points at. A repo-supplied `bin` entry is how a link into the MIT
# tree would be created, so checking only the clone would miss it entirely.
GUARD_REPO_ROOT="$(garrison_repo_root "$SCRIPT_DIR")"
guard_outside_tree "clone" "$CLONE"

[ -d "$CLONE/.git" ] || fail "clone missing at $CLONE (re-run setup)"

[ -L "$BIN" ] || fail "$BIN is not a symlink to the built CLI (re-run setup)"
[ -e "$BIN" ] || fail "$BIN is a broken symlink (the clone moved or was cleaned; re-run setup)"

TARGET="$(readlink "$BIN" 2>/dev/null)" || fail "could not read the link at $BIN"
case "$TARGET" in
  /*) : ;;
  *) TARGET="$(dirname "$BIN")/$TARGET" ;;
esac
TARGET="$(resolve_abs "$TARGET")"
guard_outside_tree "the published binary" "$TARGET"
require_inside_clone "the published binary" "$TARGET" "$CLONE"

# The pin, compared EXACTLY. A prefix comparison would bless a hand-edited
# 4-character ref, which is the opposite of what a pin is for.
HEAD_SHA="$(git -C "$CLONE" rev-parse HEAD 2>/dev/null)" || fail "could not read HEAD in $CLONE"
[ "$HEAD_SHA" = "$REF" ] ||
  fail "pin drift: $CLONE is at $HEAD_SHA but the receipt records $REF (re-run setup)"

# The binary must run with NO provider configuration at all — the whole degraded-ok
# claim. Same helper, same stripped variables, same hard ceiling as setup, so the
# two can only ever reach the same verdict.
PROBE_OUT="$(mktemp "${TMPDIR:-/tmp}/cortex-client-verify.XXXXXX")" || fail "could not create a temp file"
trap 'rm -f "$PROBE_OUT"' EXIT

require_shebang "$TARGET"
if ! probe_cli "$BIN" "$PROBE_OUT"; then
  fail "'${BIN_NAME:-cortex} --version' did not exit 0 within ${PROBE_TIMEOUT_SECS}s — the clone is not built, or the binary no longer runs (re-run setup)"
fi
VERSION_OUT="$(head -n 1 "$PROBE_OUT" | tr -d '\r')"
[ -n "$VERSION_OUT" ] || fail "'${BIN_NAME:-cortex} --version' printed nothing"

echo "[$FIT] ${BIN_NAME:-cortex} $VERSION_OUT at $BIN (pin $HEAD_SHA)"

# Credential status only — presence, never the value, never a prefix of it.
if [ -n "${CORTEX_API_KEY:-}" ]; then
  echo "[$FIT] CORTEX_API_KEY: provisioned"
else
  echo "[$FIT] CORTEX_API_KEY: absent — the CLI is installed but cannot call the provider yet (not a failure)"
fi

echo "ok"
