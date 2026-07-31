#!/usr/bin/env bash
# cortex-client setup — install a capability CLI from a PINNED clone kept OUTSIDE
# Garrison's own (MIT) source tree, and expose it as ONE stable binary path.
#
# Shape borrowed from fittings/seed/coord-agentmail/scripts/setup.sh: the
# license-isolation guard runs BEFORE any write, the clone is pinned to an exact
# commit, and the third-party tree is arm's-length — cloned, built and invoked as a
# separate process, never vendored into this repository.
#
# Idempotent: re-running re-checks the pin, rebuilds only when the pin moved or the
# build output is gone, and RE-POINTS the symlink instead of adding another one.
#
# Unconfigured (no repo_url) is a supported, silent, shipped-default state: nothing
# is installed, nothing is written, exit 0.
set -uo pipefail

FIT="cortex-client"
say() { echo "[$FIT] $*"; }
die() { echo "[$FIT] ERROR: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# 0) Configuration. The runner projects x-garrison.config_schema as
#    CORTEX_CLIENT_<KEY>; every value has a defined default and NONE of the
#    defaults name a provider URL, repository or credential (CAPABILITY_CONTRACT
#    rule 6 — a fresh clone with an empty vault must compose, run and verify).
# ---------------------------------------------------------------------------
GH="${GARRISON_HOME:-$HOME/.garrison}"
REPO_URL="${CORTEX_CLIENT_REPO_URL:-}"
GIT_REF="${CORTEX_CLIENT_GIT_REF:-}"
BASE_URL="${CORTEX_CLIENT_BASE_URL:-}"
BIN_DIR_RAW="${CORTEX_CLIENT_BIN_DIR:-$GH/bin}"
CLONE_RAW="${CORTEX_CLIENT_CLONE_DIR:-$GH/external/cortex-cli}"
PKG_SUBDIR="${CORTEX_CLIENT_PACKAGE_SUBDIR:-clients/cortex-cli}"

expand_tilde() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Absolute path for a path that does not exist yet (the guard has to run before we
# create anything). realpath -m / python3 normalise `..`; the printf fallback does
# not, which is why guard_outside_tree refuses `..` segments outright.
resolve_abs() {
  local p
  p="$(expand_tilde "$1")"
  case "$p" in /*) : ;; *) p="$PWD/$p" ;; esac
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$p" 2>/dev/null || printf '%s' "$p"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$p" 2>/dev/null || printf '%s' "$p"
  else
    printf '%s' "$p"
  fi
}

CLONE="$(resolve_abs "$CLONE_RAW")"
BIN_DIR="$(resolve_abs "$BIN_DIR_RAW")"
STATE="$GH/$FIT"
RECEIPT="$STATE/install.json"

# ---------------------------------------------------------------------------
# 1) LICENSE ISOLATION GUARD — runs BEFORE any clone, mkdir or write, and before
#    the unconfigured early-exit, so a bad path can never be acted on.
#
#    The client repository carries its own licence and its own history. Cloning it
#    (or linking into it) anywhere inside Garrison's MIT worktree would mix foreign
#    bytes into this repository and put them in front of `apm install`, git and the
#    packager. Third-party code stays arm's-length under GARRISON_HOME.
# ---------------------------------------------------------------------------
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"

guard_outside_tree() {
  local label="$1" p="$2"
  case "/$p/" in
    */../*) die "$label ($p) contains a '..' segment — refusing to resolve it, aborting before any write" ;;
  esac
  if [ -n "$REPO_ROOT" ]; then
    case "$p/" in
      "$REPO_ROOT"/*)
        die "$label ($p) is INSIDE Garrison's own source tree ($REPO_ROOT) — aborting before any write" ;;
    esac
  fi
  case "$p" in
    */dev/garrison/*|*/Projects/garrison/*)
      die "$label ($p) matches a Garrison source path — aborting before any write" ;;
  esac
}

guard_outside_tree "clone_dir" "$CLONE"
guard_outside_tree "bin_dir" "$BIN_DIR"

# ---------------------------------------------------------------------------
# 2) Unconfigured is the shipped default: install nothing, write nothing.
# ---------------------------------------------------------------------------
if [ -z "$REPO_URL" ]; then
  say "no repo_url configured — nothing installed (shipped default; consumers take their no-op path)"
  if [ -f "$RECEIPT" ]; then
    say "note: an earlier install is still recorded in $RECEIPT; delete $CLONE and that receipt by hand to undo it"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 3) A PIN, not a branch. A moving ref would swap the installed binary under a
#    machine that only ever re-ran setup, with nothing in the logs to show it.
# ---------------------------------------------------------------------------
case "$GIT_REF" in
  "") die "git_ref is not set — pin an exact commit SHA (a branch name or tag is refused)" ;;
  *[!0-9a-fA-F]*) die "git_ref ('$GIT_REF') is not a commit SHA — pin an exact commit, not a branch or tag" ;;
esac
if [ "${#GIT_REF}" -lt 7 ] || [ "${#GIT_REF}" -gt 40 ]; then
  die "git_ref ('$GIT_REF') is not a commit SHA — expected 7 to 40 hex characters"
fi

for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required to install the CLI but is not on PATH"
done

# ---------------------------------------------------------------------------
# 4) Clone (once) and check the pin out (every run).
#
#    repo_url is never echoed and never recorded: a git remote can carry an
#    embedded token, and setup output goes straight into the run log.
#    A credential prompt would hang here until the setup timeout, so git is told
#    to fail instead of asking.
# ---------------------------------------------------------------------------
export GIT_TERMINAL_PROMPT=0
if [ ! -d "$CLONE/.git" ]; then
  if [ -e "$CLONE" ] && [ -n "$(ls -A "$CLONE" 2>/dev/null)" ]; then
    die "$CLONE exists and is not a git clone — refusing to clobber it"
  fi
  mkdir -p "$(dirname "$CLONE")" || die "could not create $(dirname "$CLONE")"
  say "cloning the client repository (arm's-length, license-isolated) → $CLONE"
  git clone --quiet "$REPO_URL" "$CLONE" || die "clone failed"
else
  say "clone present at $CLONE"
fi

# Best effort: an offline box still installs, as long as the pin is already fetched.
git -C "$CLONE" fetch --quiet --tags origin >/dev/null 2>&1

git -C "$CLONE" checkout --quiet --detach "$GIT_REF" >/dev/null 2>&1 ||
  die "could not check out pin $GIT_REF (unknown commit, or the clone could not be fetched)"

HEAD_SHA="$(git -C "$CLONE" rev-parse HEAD 2>/dev/null)" || die "could not read HEAD after checkout"
say "pinned at $HEAD_SHA"

# ---------------------------------------------------------------------------
# 5) Read the CLI package's own manifest for the workspace to build and the
#    executable to link. Nothing about a provider's layout is hardcoded here:
#    package.json `name` and `bin` are the npm contract.
# ---------------------------------------------------------------------------
PKG_DIR="$CLONE/$PKG_SUBDIR"
[ -f "$PKG_DIR/package.json" ] ||
  die "no package.json at '$PKG_SUBDIR' inside the clone — check the package_subdir config"

PKG_INFO="$(node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const name = String(pkg.name || "");
  let binName = "";
  let binPath = "";
  if (typeof pkg.bin === "string") {
    binName = name.split("/").pop();
    binPath = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === "object") {
    const keys = Object.keys(pkg.bin);
    if (keys.length > 0) {
      binName = keys[0];
      binPath = String(pkg.bin[keys[0]]);
    }
  }
  process.stdout.write([name, binName, binPath].join("\n"));
' "$PKG_DIR/package.json")" || die "could not read $PKG_SUBDIR/package.json"

WORKSPACE=""
BIN_NAME=""
BIN_REL=""
{
  read -r WORKSPACE
  read -r BIN_NAME
  read -r BIN_REL
} <<EOF
$PKG_INFO
EOF

[ -n "$WORKSPACE" ] || die "$PKG_SUBDIR/package.json declares no name — cannot build a workspace"
[ -n "$BIN_NAME" ] && [ -n "$BIN_REL" ] ||
  die "$PKG_SUBDIR/package.json declares no bin entry — nothing to link"

BIN_TARGET="$PKG_DIR/${BIN_REL#./}"

# Does the built CLI actually run? `--version` is the one invocation that needs no
# configuration, so it doubles as the build probe. Run it with the provider vars
# explicitly stripped so a probe can never pass only because a key happened to be
# in the environment.
probe_bin() {
  if [ -x "$BIN_TARGET" ] && env -u CORTEX_API_KEY -u CORTEX_BASE_URL "$BIN_TARGET" --version >/dev/null 2>&1; then
    return 0
  fi
  env -u CORTEX_API_KEY -u CORTEX_BASE_URL node "$BIN_TARGET" --version >/dev/null 2>&1
}

receipt_ref() {
  [ -f "$RECEIPT" ] || return 0
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(doc.ref || ""));
    } catch { /* an unreadable receipt just means "rebuild" */ }
  ' "$RECEIPT" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 6) Install + build, but only when the pin moved or the build output is gone.
#    The clone MUST keep its node_modules and stay built: the CLI resolves its
#    workspace dependencies at runtime through those symlinks.
# ---------------------------------------------------------------------------
PREV_REF="$(receipt_ref)"
if [ "$PREV_REF" = "$HEAD_SHA" ] && probe_bin; then
  say "already installed at this pin — skipping install and build"
else
  say "npm install (workspaces) in $CLONE"
  (cd "$CLONE" && npm install --no-audit --no-fund) || die "npm install failed in $CLONE"
  say "building workspace $WORKSPACE"
  (cd "$CLONE" && npm run build --workspace "$WORKSPACE") || die "build failed for $WORKSPACE"
  probe_bin || die "the CLI does not run after the build (expected '$BIN_NAME --version' to exit 0)"
fi

# ---------------------------------------------------------------------------
# 7) One stable binary path. `ln -sfn` RE-POINTS an existing link rather than
#    nesting a second one inside it; a real file of the same name is never
#    clobbered — that would eat something the user put there.
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR" || die "could not create bin dir $BIN_DIR"
# Consumers invoke the receipt's `bin` path directly, so the link target has to be
# executable — npm normally does this when it links a workspace bin, but a clone
# that was built without that step would otherwise pass setup and fail verify.
[ -x "$BIN_TARGET" ] || chmod +x "$BIN_TARGET" 2>/dev/null || true
LINK="$BIN_DIR/$BIN_NAME"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  die "$LINK exists and is not a symlink — refusing to clobber it (point bin_dir elsewhere)"
fi
ln -sfn "$BIN_TARGET" "$LINK" || die "could not link $LINK → $BIN_TARGET"

# ---------------------------------------------------------------------------
# 8) The install receipt: how every consumer finds the binary (see for_consumers).
#    Paths, the pin and the configured origin only — NEVER a credential.
# ---------------------------------------------------------------------------
mkdir -p "$STATE" || die "could not create $STATE"
TMP="$RECEIPT.tmp.$$"
node -e '
  const [binName, bin, clone, packageDir, ref, baseUrl] = process.argv.slice(1);
  process.stdout.write(
    JSON.stringify(
      {
        fitting: "cortex-client",
        bin_name: binName,
        bin,
        clone,
        package_dir: packageDir,
        ref,
        base_url: baseUrl,
        updated_at: new Date().toISOString()
      },
      null,
      2
    ) + "\n"
  );
' "$BIN_NAME" "$LINK" "$CLONE" "$PKG_DIR" "$HEAD_SHA" "$BASE_URL" >"$TMP" ||
  { rm -f "$TMP"; die "could not write the install receipt"; }
mv -f "$TMP" "$RECEIPT" || { rm -f "$TMP"; die "could not publish the install receipt"; }

if [ -z "$BASE_URL" ]; then
  say "note: base_url is not configured — consumers must supply CORTEX_BASE_URL themselves"
fi
say "setup complete — '$BIN_NAME' at $LINK (pin $HEAD_SHA); receipt at $RECEIPT"
