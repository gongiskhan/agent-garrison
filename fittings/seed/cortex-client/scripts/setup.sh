#!/usr/bin/env bash
# cortex-client setup — install a capability CLI from a PINNED clone kept OUTSIDE
# Garrison's own (MIT) source tree, and expose it as ONE stable binary path.
#
# WHAT THE GUARD DOES AND DOES NOT DO. The path guard below is BYTE CONTAINMENT:
# it decides where the cloned repository's files, links and mode changes may land,
# and it refuses anything inside Garrison's worktree. It does NOT sandbox the
# repository. Building a repository runs that repository's code, and it runs with
# whatever the runner put in this hook's environment — which includes the
# composition's materialised vault. Setting repo_url is therefore a trust decision
# about that repository, stated plainly here and in for_consumers rather than
# implied away by the word "isolated". What IS reduced here: `npm install
# --ignore-scripts` blocks the install lifecycle (preinstall/postinstall) on the
# repository AND on every dependency, and a repo .npmrc cannot re-enable it.
# It does NOT stop everything: `prepare` still runs for every WORKSPACE MEMBER
# package, and the declared `build` runs by design. So repo code executes here
# either way - measured, not assumed.
#
# Idempotent: re-running re-checks the pin, rebuilds only when the pin moved or the
# build output stopped working, and RE-POINTS the symlink instead of adding one.
#
# Unconfigured (no repo_url) is a supported state in both directions: nothing is
# installed, and clearing repo_url afterwards withdraws what was published.
set -uo pipefail

# Before anything else: an inherited xtrace would echo every expansion — including
# repo_url — into the run log. SHELLOPTS is readonly in bash, so `set +x` is what
# actually turns it off; the unsets are best effort for shells where it is not.
set +x
unset BASH_XTRACEFD 2>/dev/null || true
unset SHELLOPTS 2>/dev/null || true

FIT="cortex-client"
say() { echo "[$FIT] $*"; }

# Armed only once we are past the guard and know we are configured, so a refused
# path or a bad pin still writes NOTHING.
MARK_FAILURES=0
die() {
  echo "[$FIT] ERROR: $*" >&2
  if [ "$MARK_FAILURES" = "1" ]; then
    write_failure_marker "$*"
  fi
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# 0) Configuration. The runner projects x-garrison.config_schema as
#    CORTEX_CLIENT_<KEY>; every value has a defined default and NONE of the
#    defaults name a provider URL, repository or credential (CAPABILITY_CONTRACT
#    rule 6 — a fresh clone with an empty vault must compose, run and verify).
#    An empty bin_dir/clone_dir means "derive from GARRISON_HOME", so every path
#    this Fitting owns moves together when the instance home moves.
# ---------------------------------------------------------------------------
GH="${GARRISON_HOME:-$HOME/.garrison}"
REPO_URL="${CORTEX_CLIENT_REPO_URL:-}"
GIT_REF="${CORTEX_CLIENT_GIT_REF:-}"
BASE_URL="${CORTEX_CLIENT_BASE_URL:-}"
BIN_DIR_RAW="${CORTEX_CLIENT_BIN_DIR:-}"
CLONE_RAW="${CORTEX_CLIENT_CLONE_DIR:-}"
PKG_SUBDIR="${CORTEX_CLIENT_PACKAGE_SUBDIR:-clients/cortex-cli}"
[ -n "$BIN_DIR_RAW" ] || BIN_DIR_RAW="$GH/bin"
[ -n "$CLONE_RAW" ] || CLONE_RAW="$GH/external/cortex-cli"

# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

CLONE="$(resolve_abs "$CLONE_RAW")"
BIN_DIR="$(resolve_abs "$BIN_DIR_RAW")"
STATE="$GH/$FIT"
RECEIPT="$STATE/install.json"
MARKER="$STATE/install-failed.json"

write_failure_marker() {
  command -v node >/dev/null 2>&1 || return 0
  mkdir -p "$STATE" 2>/dev/null || return 0
  local tmp="$MARKER.tmp.$$"
  node -e '
    process.stdout.write(
      JSON.stringify(
        { fitting: "cortex-client", failed_at: new Date().toISOString(), reason: process.argv[1] },
        null,
        2
      ) + "\n"
    );
  ' "$1" >"$tmp" 2>/dev/null && mv -f "$tmp" "$MARKER" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
  return 0
}

receipt_field() {
  [ -f "$RECEIPT" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(doc[process.argv[2]] ?? ""));
    } catch { /* an unreadable receipt just means "rebuild" */ }
  ' "$RECEIPT" "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 1) BYTE-CONTAINMENT GUARD — runs BEFORE any clone, mkdir or write, and before
#    the unconfigured early-exit, so a bad path can never be acted on.
#
#    The client repository carries its own licence and its own history. Cloning it
#    (or linking into it, or chmodding inside it) anywhere in Garrison's MIT
#    worktree would mix foreign bytes into this repository and put them in front of
#    `apm install`, git and the packager. EVERY path this script writes to, links
#    from or chmods is guarded — including the two that come from the repository
#    itself (step 6), which are input, not configuration.
# ---------------------------------------------------------------------------
GUARD_REPO_ROOT="$(garrison_repo_root "$SCRIPT_DIR")"
guard_outside_tree "clone_dir" "$CLONE"
guard_outside_tree "bin_dir" "$BIN_DIR"

# ---------------------------------------------------------------------------
# 2) Unconfigured, in BOTH directions: never configured, or configured and then
#    cleared. Clearing repo_url withdraws exactly what this Fitting published.
# ---------------------------------------------------------------------------
# A configured repo_url means every later refusal - a guarded path, a credential
# URL, a bad pin - is a CONFIGURED-AND-BROKEN outcome, not "never configured".
# Arming the marker here rather than at the first write is what stops verify
# reporting a deliberate configuration error as the shipped default and exiting 0.
if [ -n "$REPO_URL" ]; then
  MARK_FAILURES=1
fi

if [ -z "$REPO_URL" ]; then
  if [ -f "$RECEIPT" ] || [ -f "$MARKER" ]; then
    PREV_BIN="$(receipt_field bin)"
    PREV_CLONE="$(receipt_field clone)"
    # Only what this Fitting published: its receipt, its failure marker, and the
    # symlink it created. A real file of that name is never touched, and the clone
    # is left on disk rather than silently deleted.
    if [ -n "$PREV_BIN" ] && [ -L "$PREV_BIN" ]; then
      rm -f "$PREV_BIN"
    fi
    rm -f "$RECEIPT" "$MARKER"
    say "repo_url cleared — withdrew the published binary and receipt; consumers now take their no-op path"
    if [ -n "$PREV_CLONE" ]; then
      say "the clone at $PREV_CLONE is left on disk; delete it by hand to reclaim the space"
    fi
  else
    say "no repo_url configured — nothing installed (shipped default; consumers take their no-op path)"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 3) Reject a credential-bearing remote outright rather than mitigating it. git
#    records the remote VERBATIM in <clone>/.git/config, and the URL is an argv of
#    `git clone`, i.e. world-readable in /proc/<pid>/cmdline while it runs. Neither
#    is something this Fitting can undo after the fact.
# ---------------------------------------------------------------------------
_cred_die() {
  die "repo_url carries a credential in the URL ($1). Refused: git writes the remote VERBATIM into <clone>/.git/config and the URL is an argv of git clone, so it is readable in /proc while it runs - both true of any transport. Use git@host:org/repo.git or ssh://git@host/org/repo.git (a username is not a secret), or configure a git credential helper."
}
case "$REPO_URL" in
  *://*)
    _authority="${REPO_URL#*://}"
    _authority="${_authority%%/*}"
    _userinfo="${_authority%%@*}"
    case "$_authority" in
      *@*)
        case "$REPO_URL" in
          # http(s) treats the userinfo as credentials whether or not a colon is
          # present - a bare `token@host` is exactly how a PAT is passed - so any
          # userinfo is refused on those schemes.
          http://*|https://*) _cred_die "user[:secret]@host on an http(s) URL" ;;
          # Other transports: `git@host` is the STANDARD, credential-free spelling
          # that GitHub and GitLab hand you. Only an embedded secret (a colon in
          # the userinfo) is a credential. Refusing git@host would reject the very
          # form this message recommends.
          *) case "$_userinfo" in *:*) _cred_die "user:secret@host" ;; esac ;;
        esac ;;
    esac
    ;;
  # scp-style (user@host:path) has no scheme, so the branch above cannot see it.
  # The colon after the host is a path separator, not a secret - only a colon
  # BEFORE the @ is one.
  *@*:*)
    case "${REPO_URL%%@*}" in
      *:*) _cred_die "user:secret@host:path (scp-style)" ;;
    esac
    ;;
esac

# ---------------------------------------------------------------------------
# 4) A FULL-LENGTH commit sha — not a branch, not a tag, not an abbreviation. A
#    moving ref would swap the installed binary under a machine that only re-ran
#    setup; an abbreviation cannot be compared exactly at verify time.
# ---------------------------------------------------------------------------
case "$GIT_REF" in
  "") die "git_ref is not set — pin a full commit sha (a branch name or tag is refused)" ;;
  *[!0-9a-fA-F]*) die "git_ref ('$GIT_REF') is not a commit sha — pin an exact commit, not a branch or tag" ;;
esac
if [ "${#GIT_REF}" -ne 40 ] && [ "${#GIT_REF}" -ne 64 ]; then
  die "git_ref ('$GIT_REF') is ${#GIT_REF} characters — pin the FULL sha (40 hex, or 64 for a sha-256 repository), never an abbreviation"
fi

for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required to install the CLI but is not on PATH"
done

# Already armed above, the moment we knew repo_url was configured. Left here as a
# no-op so the reason stays where the writes begin.
MARK_FAILURES=1

# ---------------------------------------------------------------------------
# 5) Clone (once) and check the pin out (every run).
#
#    repo_url is never echoed and never recorded. A credential prompt would hang
#    here until the setup timeout, so git is told to fail instead of asking.
# ---------------------------------------------------------------------------
export GIT_TERMINAL_PROMPT=0
if [ ! -d "$CLONE/.git" ]; then
  if [ -e "$CLONE" ] && [ -n "$(ls -A "$CLONE" 2>/dev/null)" ]; then
    die "$CLONE exists and is not a git clone — refusing to clobber it"
  fi
  mkdir -p "$(dirname "$CLONE")" || die "could not create $(dirname "$CLONE")"
  say "cloning the client repository (byte-contained under GARRISON_HOME) → $CLONE"
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
# 6) Locate the CLI package and its executable. Two inputs here are NOT trusted
#    configuration: package_subdir is concatenated onto the clone path, and `bin`
#    comes out of the CLONED REPOSITORY's package.json. Both reach chmod and ln,
#    so both are validated and guarded exactly like the operator's directories.
# ---------------------------------------------------------------------------
case "$PKG_SUBDIR" in
  "") die "package_subdir is empty — it must name the CLI's package inside the clone" ;;
  /*) die "package_subdir ('$PKG_SUBDIR') must be relative to the clone" ;;
esac
case "/$PKG_SUBDIR/" in
  */../*) die "package_subdir ('$PKG_SUBDIR') must not contain a '..' segment" ;;
esac

PKG_DIR="$(resolve_abs "$CLONE/$PKG_SUBDIR")"
guard_outside_tree "package_subdir" "$PKG_DIR"
require_inside_clone "package_subdir" "$PKG_DIR" "$CLONE"

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

# The bin NAME becomes a filename in the operator's bin dir.
case "$BIN_NAME" in
  *[!A-Za-z0-9._-]*) die "the package's bin name ('$BIN_NAME') contains characters that are not allowed in a linked binary name" ;;
  .*|-*) die "the package's bin name ('$BIN_NAME') may not start with '.' or '-'" ;;
esac
# The bin PATH is repo-controlled and reaches chmod and ln.
case "$BIN_REL" in
  /*) die "the package's bin path ('$BIN_REL') is absolute — it must point inside the package" ;;
esac
case "/$BIN_REL/" in
  */../*) die "the package's bin path ('$BIN_REL') contains a '..' segment — refusing" ;;
esac

BIN_TARGET="$(resolve_abs "$PKG_DIR/${BIN_REL#./}")"
guard_outside_tree "the package's bin path" "$BIN_TARGET"
require_inside_clone "the package's bin path" "$BIN_TARGET" "$CLONE"

PROBE_OUT="$(mktemp "${TMPDIR:-/tmp}/cortex-client-probe.XXXXXX")" || die "could not create a temp file"
trap 'rm -f "$PROBE_OUT"' EXIT

# ---------------------------------------------------------------------------
# 7) Install + build, but only when the pin moved or the build output stopped
#    working. The clone MUST keep its node_modules and stay built: the CLI
#    resolves its workspace dependencies at runtime through those symlinks.
#
#    --ignore-scripts on both: install lifecycles do not execute, on the
#    repository or on any dependency, and no pre/post wrapper runs around the
#    build. It is NOT a sandbox: a workspace member's `prepare` still runs, and
#    the declared `build` runs by design. Repo code executes here with this
#    hook's environment - see the header and for_consumers.
# ---------------------------------------------------------------------------
PREV_REF="$(receipt_field ref)"
# require_shebang before the probe, so the fast path cannot bless a binary verify
# would refuse: they must apply the SAME test or setup writes a success receipt
# over an install verify then calls broken.
if [ "$PREV_REF" = "$HEAD_SHA" ] && require_shebang "$BIN_TARGET" 2>/dev/null && probe_cli "$BIN_TARGET" "$PROBE_OUT"; then
  say "already installed at this pin — skipping install and build"
else
  say "npm install (workspaces, --ignore-scripts) in $CLONE"
  (cd "$CLONE" && npm install --ignore-scripts --no-audit --no-fund) || die "npm install failed in $CLONE"
  say "building workspace $WORKSPACE"
  (cd "$CLONE" && npm run build --workspace "$WORKSPACE" --ignore-scripts) ||
    die "build failed for $WORKSPACE"

  # Consumers exec the receipt's `bin` path directly, so the shape check and the
  # probe here are exactly what verify re-applies — same helper, same bounds, so
  # setup can never bless a binary verify would then refuse.
  require_shebang "$BIN_TARGET"
  [ -x "$BIN_TARGET" ] || chmod +x "$BIN_TARGET" 2>/dev/null || true
  probe_cli "$BIN_TARGET" "$PROBE_OUT" ||
    die "the CLI does not run after the build (expected '$BIN_NAME --version' to exit 0 within ${PROBE_TIMEOUT_SECS}s)"
fi

# ---------------------------------------------------------------------------
# 8) One stable binary path. `ln -sfn` RE-POINTS an existing link rather than
#    nesting a second one inside it; a real file of the same name is never
#    clobbered — that would eat something the user put there.
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR" || die "could not create bin dir $BIN_DIR"
LINK="$BIN_DIR/$BIN_NAME"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  die "$LINK exists and is not a symlink — refusing to clobber it (point bin_dir elsewhere)"
fi
ln -sfn "$BIN_TARGET" "$LINK" || die "could not link $LINK → $BIN_TARGET"

# ---------------------------------------------------------------------------
# 9) The install receipt: how every consumer finds the binary (see for_consumers).
#    Paths, the pin and the configured origin only — never a credential, and never
#    repo_url, which names a host the operator may authenticate to.
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
rm -f "$MARKER"

if [ -z "$BASE_URL" ]; then
  say "note: base_url is not configured — consumers must supply CORTEX_BASE_URL themselves"
fi
say "setup complete — '$BIN_NAME' at $LINK (pin $HEAD_SHA); receipt at $RECEIPT"
