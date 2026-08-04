#!/usr/bin/env bash
# Mac-side controller for running Garrison commands on dev-madrid without a
# local project runtime. Source is captured as a temporary Git snapshot; the
# VM's live checkout and its prod/dev processes are never used as a worktree.

set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)"

REMOTE_HOST="${GARRISON_REMOTE_HOST:-dev-madrid}"
CANONICAL_REMOTE_REPO="/home/ggomes/dev/garrison"
REMOTE_REPO="${GARRISON_REMOTE_REPO:-$CANONICAL_REMOTE_REPO}"
REMOTE_CACHE="/home/ggomes/.cache/garrison-mac-remote-dev"
REMOTE_LOCK="/tmp/garrison-mac-remote-dev.lock"
EXPECTED_USER="ggomes"
EXPECTED_HOST="dev-madrid"
EXPECTED_GCP_PROJECT="spatial-tempo-488909-s5"
EXPECTED_GCP_ZONE="europe-southwest1-a"
EXPECTED_GCP_INSTANCE="dev-madrid"
EXPECTED_ORIGIN="https://github.com/gongiskhan/agent-garrison.git"
REMOTE_PREVIEW_PORT=27777
LOCAL_PREVIEW_PORT="${GARRISON_LOCAL_PREVIEW_PORT:-27777}"

SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ExitOnForwardFailure=yes
  -o ForwardAgent=no
  -o IdentitiesOnly=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=yes
)

LOCAL_TMP=""
REMOTE_STAGE=""

die() {
  printf '[garrison-remote] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/remote-dev.sh <command> [arguments]

Read-only checks:
  doctor                 Verify Mac tools, SSH/GCP identity, repo, and services
  plan                   Show exactly which local changes a snapshot will use
  prod-status             Show the live prod/dev service and listener status

Temporary snapshot commands (all project execution happens on dev-madrid):
  typecheck              Run npm run typecheck
  test [vitest args...]  Run npm test, optionally limited to named test files
  check                  Run typecheck, then unit tests
  build                  Run a codex-profile Next build
  preview                Start a codex-profile preview and tunnel it to the Mac
  shell                  Open an isolated shell in the temporary snapshot
  run -- <command...>     Run any command in the temporary snapshot

Continuity and release:
  resume <session-uuid> [resume-despite-local-changes]
                         Resume a Claude Code session in the canonical VM repo
  deploy <confirmation>  Verify, fast-forward, and redeploy production

Production confirmation must be exactly: deploy-garrison-prod

Environment overrides:
  GARRISON_REMOTE_HOST         SSH alias (default: dev-madrid)
  GARRISON_REMOTE_REPO         alternate VM object source for snapshot commands
                               (resume/deploy always require the canonical path)
  GARRISON_LOCAL_PREVIEW_PORT  Mac loopback port (default: 27777)
USAGE
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required Mac command is unavailable: $1"
}

validate_configuration() {
  case "$REMOTE_HOST" in
    ''|-*|*[!A-Za-z0-9._-]*) die "unsafe SSH host alias: $REMOTE_HOST" ;;
  esac
  case "$REMOTE_REPO" in
    /home/ggomes/dev/*) ;;
    *) die "remote repo must stay below /home/ggomes/dev" ;;
  esac
  case "$LOCAL_PREVIEW_PORT" in
    ''|*[!0-9]*) die "local preview port must be numeric" ;;
  esac
  [ "$LOCAL_PREVIEW_PORT" -ge 1024 ] 2>/dev/null \
    && [ "$LOCAL_PREVIEW_PORT" -le 65535 ] 2>/dev/null \
    || die "local preview port must be between 1024 and 65535"

  [ -e "$REPO_ROOT/.git" ] || die "this script must run from the Garrison checkout"
  [ "$(git -C "$REPO_ROOT" rev-parse --show-toplevel)" = "$REPO_ROOT" ] \
    || die "could not resolve the Garrison repository root"
  [ "$(git -C "$REPO_ROOT" remote get-url origin)" = "$EXPECTED_ORIGIN" ] \
    || die "local origin is not the expected agent-garrison repository"
}

join_quoted() {
  local result="" argument quoted
  for argument in "$@"; do
    printf -v quoted '%q' "$argument"
    if [ -n "$result" ]; then
      result="$result $quoted"
    else
      result="$quoted"
    fi
  done
  REPLY="$result"
}

ssh_exec() {
  join_quoted "$@"
  ssh "${SSH_OPTIONS[@]}" -T "$REMOTE_HOST" "$REPLY"
}

ssh_tty_exec() {
  join_quoted "$@"
  ssh "${SSH_OPTIONS[@]}" -tt "$REMOTE_HOST" "$REPLY"
}

scp_to_remote() {
  local source="$1" destination="$2"
  scp "${SSH_OPTIONS[@]}" -q -- "$source" "$REMOTE_HOST:$destination"
}

verify_remote_identity() {
  local actual expected
  actual="$(ssh_exec bash -s -- "$REMOTE_REPO" <<'REMOTE'
set -euo pipefail
repo="$1"
metadata="http://metadata.google.internal/computeMetadata/v1"
header="Metadata-Flavor: Google"
zone="$(curl -fsS --connect-timeout 2 --max-time 5 -H "$header" "$metadata/instance/zone")"
printf 'user=%s\n' "$(id -un)"
printf 'host=%s\n' "$(hostname -s)"
printf 'project=%s\n' "$(curl -fsS --connect-timeout 2 --max-time 5 -H "$header" "$metadata/project/project-id")"
printf 'instance=%s\n' "$(curl -fsS --connect-timeout 2 --max-time 5 -H "$header" "$metadata/instance/name")"
printf 'zone=%s\n' "${zone##*/}"
printf 'repo=%s\n' "$(realpath "$repo")"
printf 'origin=%s\n' "$(git -C "$repo" remote get-url origin)"
REMOTE
)"

  expected="$(printf 'user=%s\nhost=%s\nproject=%s\ninstance=%s\nzone=%s\nrepo=%s\norigin=%s' \
    "$EXPECTED_USER" \
    "$EXPECTED_HOST" \
    "$EXPECTED_GCP_PROJECT" \
    "$EXPECTED_GCP_INSTANCE" \
    "$EXPECTED_GCP_ZONE" \
    "$REMOTE_REPO" \
    "$EXPECTED_ORIGIN")"

  if [ "$actual" != "$expected" ]; then
    printf '[garrison-remote] expected remote identity:\n%s\n' "$expected" >&2
    printf '[garrison-remote] received remote identity:\n%s\n' "$actual" >&2
    die "SSH target identity check failed"
  fi
}

reject_ambiguous_git_state() {
  local repo_root="${1:-$REPO_ROOT}" bad
  [ -z "$(git -C "$repo_root" ls-files -u)" ] \
    || die "the local checkout has unresolved merge entries"

  bad="$(git -C "$repo_root" ls-files -v | awk 'substr($0,1,1) ~ /[a-z]/ && !found { print; found=1 }')"
  [ -z "$bad" ] \
    || die "assume-unchanged index state is unsupported: $bad"

  bad="$(git -C "$repo_root" ls-files -t | awk '$1 == "S" && !found { print; found=1 }')"
  [ -z "$bad" ] \
    || die "skip-worktree/sparse index state is unsupported: $bad"

  bad="$(git -C "$repo_root" ls-files --stage | awk '$1 == "160000" && !found { print; found=1 }')"
  [ -z "$bad" ] \
    || die "submodules are not supported by the snapshot transport: $bad"

  # A link that is harmless/dangling on the Mac can resolve on dev-madrid to the
  # canonical checkout. Then an ordinary relative write in a dependency hook or
  # test escapes the snapshot. Reject every tracked link; the remote extraction
  # performs a second final-tree check for unstaged type changes and TOCTOU.
  bad="$(git -C "$repo_root" ls-files --stage | awk '$1 == "120000" && !found { print; found=1 }')"
  [ -z "$bad" ] \
    || die "tracked symlinks are not supported by the snapshot transport: $bad"
}

validate_snapshot_entry() {
  local repo_root="$1" relative_path="$2"
  case "$relative_path" in
    /*|../*|*/../*) die "unsafe untracked path: $relative_path" ;;
  esac
  [ ! -L "$repo_root/$relative_path" ] \
    || die "untracked symlinks are not supported by the snapshot transport: $relative_path"
  [ -f "$repo_root/$relative_path" ] \
    || die "unsupported untracked filesystem entry: $relative_path"
}

reject_archive_links() {
  local archive="$1" bad
  # Close the validation-to-archive race: only regular-file entries may cross.
  # Both macOS bsdtar and GNU tar prefix verbose entries with the file type.
  bad="$(tar -tvzf "$archive" | awk 'substr($0,1,1) != "-" && !found { print; found=1 }')"
  [ -z "$bad" ] \
    || die "snapshot archive contains a link or special entry: $bad"
}

require_canonical_mutation_repo() {
  [ "$REMOTE_REPO" = "$CANONICAL_REMOTE_REPO" ] \
    || die "resume/deploy must use the canonical VM checkout $CANONICAL_REMOTE_REPO; unset GARRISON_REMOTE_REPO"
}

valid_remote_stage_path() {
  [[ "$1" =~ ^/home/ggomes/\.cache/garrison-mac-remote-dev/stages/stage\.[A-Za-z0-9]{8}$ ]]
}

valid_local_tmp_path() {
  local basename="${1##*/}"
  [[ "$basename" =~ ^garrison-remote-dev\.[A-Za-z0-9]{8}$ ]] \
    && [ -d "$1" ] \
    && [ ! -L "$1" ]
}

safe_local_cleanup() {
  if [ -n "$LOCAL_TMP" ]; then
    if valid_local_tmp_path "$LOCAL_TMP"; then
      rm -rf -- "$LOCAL_TMP"
    else
      printf '[garrison-remote] refusing unexpected local cleanup path: %s\n' "$LOCAL_TMP" >&2
    fi
    LOCAL_TMP=""
  fi
}

safe_remote_cleanup() {
  if [ -n "$REMOTE_STAGE" ]; then
    if valid_remote_stage_path "$REMOTE_STAGE"; then
      if ! ssh_exec bash -s -- "$REMOTE_STAGE" "$REMOTE_CACHE" <<'REMOTE' >/dev/null 2>&1
set -euo pipefail
stage="$1"
cache="$2"
parent="${stage%/*}"
basename="${stage##*/}"
[ "$parent" = "$cache/stages" ]
[[ "$basename" =~ ^stage\.[A-Za-z0-9]{8}$ ]]
[ -d "$stage" ]
[ ! -L "$stage" ]
[ "$(realpath "$stage")" = "$stage" ]
rm -rf -- "$stage"
REMOTE
      then
        printf '[garrison-remote] warning: temporary VM snapshot cleanup failed: %s\n' \
          "$REMOTE_STAGE" >&2
      fi
    else
      printf '[garrison-remote] refusing unexpected remote cleanup path: %s\n' "$REMOTE_STAGE" >&2
    fi
    REMOTE_STAGE=""
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  safe_remote_cleanup
  safe_local_cleanup
  exit "$exit_code"
}

install_cleanup_trap() {
  trap cleanup EXIT INT TERM
}

create_snapshot_artifacts() {
  reject_ambiguous_git_state
  LOCAL_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  PATCH_FILE="$LOCAL_TMP/tracked.patch"
  UNTRACKED_LIST="$LOCAL_TMP/untracked.list"
  UNTRACKED_ARCHIVE="$LOCAL_TMP/untracked.tar.gz"
  HAS_UNTRACKED_ARCHIVE=0

  git -C "$REPO_ROOT" diff \
    --binary \
    --full-index \
    --no-ext-diff \
    --no-textconv \
    HEAD -- . > "$PATCH_FILE"
  git -C "$REPO_ROOT" ls-files --others --exclude-standard -z > "$UNTRACKED_LIST"

  if [ -s "$UNTRACKED_LIST" ]; then
    local path
    while IFS= read -r -d '' path; do
      validate_snapshot_entry "$REPO_ROOT" "$path"
    done < "$UNTRACKED_LIST"

    COPYFILE_DISABLE=1 tar --no-xattrs -C "$REPO_ROOT" -czf "$UNTRACKED_ARCHIVE" \
      --null -T "$UNTRACKED_LIST"
    reject_archive_links "$UNTRACKED_ARCHIVE"
    HAS_UNTRACKED_ARCHIVE=1
  fi

  PATCH_SHA="$(shasum -a 256 "$PATCH_FILE" | awk '{print $1}')"
  if [ "$HAS_UNTRACKED_ARCHIVE" -eq 1 ]; then
    ARCHIVE_SHA="$(shasum -a 256 "$UNTRACKED_ARCHIVE" | awk '{print $1}')"
  else
    ARCHIVE_SHA="none"
  fi
}

create_remote_stage() {
  # macOS Bash 3.2 misparses a case-pattern ')' in a heredoc nested directly
  # inside command substitution. Capture the one-line result explicitly.
  local stage_output="$LOCAL_TMP/remote-stage.out"
  ssh_exec bash -s -- "$REMOTE_CACHE" "$REMOTE_REPO" > "$stage_output" <<'REMOTE'
set -euo pipefail
cache="$1"
canonical="$2"
case "$cache" in
  /home/ggomes/.cache/garrison-mac-remote-dev) ;;
  *) printf 'unexpected cache root\n' >&2; exit 1 ;;
esac
umask 077
mkdir -p "$cache/stages"
stage="$(mktemp -d "$cache/stages/stage.XXXXXXXX")"
cleanup_error() {
  rm -rf -- "$stage"
}
trap cleanup_error ERR
mkdir "$stage/incoming"
git clone --quiet --shared --no-checkout "$canonical" "$stage/repo"
# Keep the canonical checkout available as a local fetch/object source, but
# make an ordinary `git push origin` from the advertised shell fail closed.
git -C "$stage/repo" remote set-url --push origin /dev/null
trap - ERR
printf '%s\n' "$stage"
REMOTE
  IFS= read -r REMOTE_STAGE < "$stage_output"

  valid_remote_stage_path "$REMOTE_STAGE" \
    || die "VM returned an unsafe temporary stage path: $REMOTE_STAGE"
}

checkout_snapshot_head() {
  if ssh_exec git -C "$REMOTE_REPO" cat-file -e "$LOCAL_HEAD^{commit}" >/dev/null 2>&1; then
    ssh_exec git -C "$REMOTE_STAGE/repo" checkout --quiet --detach "$LOCAL_HEAD"
    return
  fi

  local head_ref base bundle
  head_ref="$(git -C "$REPO_ROOT" symbolic-ref -q HEAD || true)"
  [ -n "$head_ref" ] \
    || die "local HEAD is not on the VM and a detached HEAD cannot be bundled safely"
  base="$(git -C "$REPO_ROOT" merge-base HEAD refs/remotes/origin/main)"
  ssh_exec git -C "$REMOTE_REPO" cat-file -e "$base^{commit}" >/dev/null 2>&1 \
    || die "the VM lacks the local branch base; fetch/push a shared base first"

  bundle="$LOCAL_TMP/commits.bundle"
  git -C "$REPO_ROOT" bundle create "$bundle" "$head_ref" "^$base"
  git -C "$REPO_ROOT" bundle verify "$bundle" >/dev/null
  scp_to_remote "$bundle" "$REMOTE_STAGE/incoming/commits.bundle"
  ssh_exec git -C "$REMOTE_STAGE/repo" fetch --quiet \
    "$REMOTE_STAGE/incoming/commits.bundle" "$head_ref"
  ssh_exec git -C "$REMOTE_STAGE/repo" checkout --quiet --detach "$LOCAL_HEAD"
}

upload_and_apply_snapshot() {
  scp_to_remote "$PATCH_FILE" "$REMOTE_STAGE/incoming/tracked.patch"
  if [ "$HAS_UNTRACKED_ARCHIVE" -eq 1 ]; then
    scp_to_remote "$UNTRACKED_ARCHIVE" "$REMOTE_STAGE/incoming/untracked.tar.gz"
  fi

  ssh_exec bash -s -- \
    "$REMOTE_STAGE" \
    "$REMOTE_CACHE" \
    "$LOCAL_HEAD" \
    "$PATCH_SHA" \
    "$ARCHIVE_SHA" \
    "$HAS_UNTRACKED_ARCHIVE" <<'REMOTE'
set -euo pipefail
stage="$1"
cache="$2"
expected_head="$3"
expected_patch_sha="$4"
expected_archive_sha="$5"
has_archive="$6"
repo="$stage/repo"
incoming="$stage/incoming"

parent="${stage%/*}"
basename="${stage##*/}"
[ "$parent" = "$cache/stages" ]
[[ "$basename" =~ ^stage\.[A-Za-z0-9]{8}$ ]]
[ -d "$stage" ]
[ ! -L "$stage" ]
[ "$(realpath "$stage")" = "$stage" ]
[ "$(git -C "$repo" rev-parse HEAD)" = "$expected_head" ]
[ "$(sha256sum "$incoming/tracked.patch" | awk '{print $1}')" = "$expected_patch_sha" ]

if [ -s "$incoming/tracked.patch" ]; then
  git -C "$repo" apply --check --binary "$incoming/tracked.patch"
  git -C "$repo" apply --binary "$incoming/tracked.patch"
fi

if [ "$has_archive" = 1 ]; then
  [ "$(sha256sum "$incoming/untracked.tar.gz" | awk '{print $1}')" = "$expected_archive_sha" ]
  tar -xzf "$incoming/untracked.tar.gz" -C "$repo" --no-same-owner --no-same-permissions
else
  [ "$expected_archive_sha" = none ]
fi

# Defense in depth after both the Git patch and untracked archive have landed.
# Exclude .git internals; no source-tree link may reach a live absolute target.
link="$(find "$repo" -path "$repo/.git" -prune -o -type l -print -quit)"
[ -z "$link" ] \
  || { printf 'snapshot source tree contains a symlink: %s\n' "$link" >&2; exit 1; }

[ -f "$repo/scripts/remote-dev-runner.sh" ] \
  || { printf 'remote runner is missing from the snapshot\n' >&2; exit 1; }
printf '[garrison-remote] snapshot ready at %s (%s)\n' "$stage" "${expected_head:0:12}"
REMOTE
}

run_snapshot_action() {
  local action="$1"
  shift

  validate_configuration
  verify_remote_identity
  require_command git
  require_command ssh
  require_command scp
  require_command tar
  require_command shasum

  LOCAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/garrison-remote-dev.XXXXXXXX")"
  install_cleanup_trap
  create_snapshot_artifacts
  create_remote_stage
  checkout_snapshot_head
  upload_and_apply_snapshot

  local runner="$REMOTE_STAGE/repo/scripts/remote-dev-runner.sh"
  local runner_args=(
    env
    "GARRISON_REMOTE_STAGE=$REMOTE_STAGE"
    "GARRISON_REMOTE_CACHE=$REMOTE_CACHE"
    "GARRISON_REMOTE_CANONICAL=$REMOTE_REPO"
    "GARRISON_REMOTE_EXPECTED_HEAD=$LOCAL_HEAD"
    bash
    "$runner"
    "$action"
  )
  runner_args+=("$@")

  if [ "$action" = preview ]; then
    printf '[garrison-remote] Mac preview: http://127.0.0.1:%s\n' "$LOCAL_PREVIEW_PORT"
    join_quoted "${runner_args[@]}"
    ssh "${SSH_OPTIONS[@]}" -tt \
      -L "127.0.0.1:$LOCAL_PREVIEW_PORT:127.0.0.1:$REMOTE_PREVIEW_PORT" \
      "$REMOTE_HOST" "$REPLY"
  elif [ "$action" = shell ]; then
    ssh_tty_exec "${runner_args[@]}"
  else
    ssh_exec "${runner_args[@]}"
  fi
}

doctor() {
  validate_configuration
  require_command git
  require_command ssh
  require_command scp
  require_command tar
  require_command shasum
  verify_remote_identity

  printf '[garrison-remote] Mac repo: %s\n' "$REPO_ROOT"
  printf '[garrison-remote] Mac HEAD: %s\n' "$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    printf '[garrison-remote] Mac worktree: changed (changes will be snapshotted)\n'
  else
    printf '[garrison-remote] Mac worktree: clean\n'
  fi

  ssh_exec bash -s -- "$REMOTE_REPO" "$REMOTE_CACHE" <<'REMOTE'
set -euo pipefail
repo="$1"
cache="$2"
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 20 --silent >/dev/null
fi
printf '[garrison-remote] VM repo: %s\n' "$repo"
printf '[garrison-remote] VM HEAD: %s\n' "$(git -C "$repo" rev-parse --short=12 HEAD)"
if [ -n "$(git -C "$repo" status --porcelain=v1 --untracked-files=all)" ]; then
  printf '[garrison-remote] VM canonical worktree: changed (deploy will refuse it)\n'
else
  printf '[garrison-remote] VM canonical worktree: clean\n'
fi
printf '[garrison-remote] VM runtime: Node %s, npm %s\n' "$(node --version)" "$(npm --version)"
printf '[garrison-remote] prod service: %s\n' "$(systemctl --user is-active garrison-prod.service || true)"
printf '[garrison-remote] dev service: %s\n' "$(systemctl --user is-active garrison-dev.service || true)"
listeners="$(ss -H -ltn | awk '$4 ~ /:(7777|8777|27777)$/ {print $4}' | paste -sd, -)"
printf '[garrison-remote] app listeners: %s\n' "${listeners:-none}"
if [ -d "$cache/stages" ]; then
  printf '[garrison-remote] active or abandoned snapshot dirs: %s\n' \
    "$(find "$cache/stages" -mindepth 1 -maxdepth 1 -type d -name 'stage.*' | wc -l | tr -d ' ')"
else
  printf '[garrison-remote] active or abandoned snapshot dirs: 0\n'
fi
REMOTE
}

plan_snapshot() {
  validate_configuration
  verify_remote_identity
  reject_ambiguous_git_state
  printf '[garrison-remote] base commit: %s\n' "$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  printf '[garrison-remote] tracked changes:\n'
  git -C "$REPO_ROOT" diff --stat HEAD -- .
  printf '[garrison-remote] complete snapshot status (ignored files are excluded):\n'
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    git -C "$REPO_ROOT" status --short --untracked-files=all
  else
    printf '  clean\n'
  fi
}

prod_status() {
  validate_configuration
  verify_remote_identity
  ssh_exec bash -s -- "$REMOTE_REPO" <<'REMOTE'
set -euo pipefail
repo="$1"
printf '[garrison-remote] canonical branch/head: %s %s\n' \
  "$(git -C "$repo" branch --show-current)" \
  "$(git -C "$repo" rev-parse --short=12 HEAD)"
printf '[garrison-remote] canonical status lines: %s\n' \
  "$(git -C "$repo" status --porcelain=v1 --untracked-files=all | wc -l | tr -d ' ')"
printf '[garrison-remote] prod service: %s\n' "$(systemctl --user is-active garrison-prod.service || true)"
printf '[garrison-remote] dev service: %s\n' "$(systemctl --user is-active garrison-dev.service || true)"
ss -H -ltnp | awk '$4 ~ /:(7777|8777|27777)$/ {print "[garrison-remote] listener: " $0}'
if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:8777/api/compositions; then
  printf '[garrison-remote] prod health: responding on loopback:8777\n'
else
  printf '[garrison-remote] prod health: NOT responding on loopback:8777\n' >&2
  exit 1
fi
REMOTE
}

resume_session() {
  local session="${1:-}" dirty_confirmation="${2:-}"
  local local_head expected_remote_state remote_state local_status
  [[ "$session" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
    || die "resume requires a Claude session UUID"
  require_canonical_mutation_repo
  validate_configuration
  verify_remote_identity
  reject_ambiguous_git_state

  [ "$(git -C "$REPO_ROOT" branch --show-current)" = main ] \
    || die "resuming the canonical VM session requires local main"
  git -C "$REPO_ROOT" fetch --quiet origin main
  local_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [ "$local_head" = "$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)" ] \
    || die "local main must match freshly fetched origin/main before resume"

  local_status="$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)"
  if [ -n "$local_status" ]; then
    [ "$dirty_confirmation" = resume-despite-local-changes ] \
      || die "local changes exist; commit them first or pass the documented resume-despite-local-changes confirmation"
    printf '[garrison-remote] WARNING: local changes remain while Claude edits the VM. Do not edit on the Mac until the remote handoff is reconciled.\n' >&2
    printf '%s\n' "$local_status" >&2
  fi

  remote_state="$(ssh_exec bash -s -- "$REMOTE_REPO" <<'REMOTE'
set -euo pipefail
repo="$1"
printf 'branch=%s\n' "$(git -C "$repo" branch --show-current)"
printf 'head=%s\n' "$(git -C "$repo" rev-parse HEAD)"
printf 'status_lines=%s' \
  "$(git -C "$repo" status --porcelain=v1 --untracked-files=all | wc -l | tr -d ' ')"
REMOTE
)"
  expected_remote_state="$(printf 'branch=main\nhead=%s\nstatus_lines=0' "$local_head")"
  if [ "$remote_state" != "$expected_remote_state" ]; then
    printf '[garrison-remote] canonical VM state:\n%s\n' "$remote_state" >&2
    die "local and canonical VM repositories must be clean and at the same main commit before resume"
  fi

  local transcript="/home/ggomes/.claude/projects/-home-ggomes-dev-garrison/$session.jsonl"
  ssh_exec test -f "$transcript" \
    || die "Claude transcript was not found on dev-madrid: $session"
  # The positional parameters are intentionally expanded by the remote bash.
  local resume_status=0
  # shellcheck disable=SC2016
  ssh_tty_exec flock \
    --close \
    --conflict-exit-code 75 \
    --nonblock \
    "$REMOTE_LOCK" \
    bash -c \
    'set -euo pipefail
fail() { printf "[garrison-remote] %s\n" "$1" >&2; exit 76; }
repo="$1"
claude_bin="$2"
session="$3"
expected_head="$4"
expected_origin="$5"
cd "$repo"
[ "$(git remote get-url origin)" = "$expected_origin" ] || fail "canonical VM origin changed before resume"
git fetch --quiet origin main || fail "could not refresh origin/main before resume"
[ "$(git branch --show-current)" = main ] || fail "canonical VM is no longer on main"
[ "$(git rev-parse HEAD)" = "$expected_head" ] || fail "canonical VM HEAD changed before resume"
[ "$(git rev-parse refs/remotes/origin/main)" = "$expected_head" ] || fail "origin/main changed before resume"
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || fail "canonical VM worktree changed before resume"
[ -z "$(git ls-files -u)" ] || fail "canonical VM has unresolved merge entries"
[ -z "$(git ls-files -v | awk '\''substr($0,1,1) ~ /[a-z]/ { print; exit }'\'')" ] || fail "canonical VM has assume-unchanged index entries"
[ -z "$(git ls-files -t | awk '\''$1 == "S" { print; exit }'\'')" ] || fail "canonical VM has skip-worktree index entries"
exec "$claude_bin" --resume "$session"' \
    -- "$REMOTE_REPO" /home/ggomes/.local/bin/claude "$session" \
    "$local_head" "$EXPECTED_ORIGIN" \
    || resume_status=$?
  if [ "$resume_status" -eq 75 ]; then
    die "a snapshot or deploy command is active; wait before resuming Claude"
  fi
  if [ "$resume_status" -eq 76 ]; then
    die "repository state changed while waiting for the workflow lock; retry after reconciling it"
  fi

  remote_state="$(ssh_exec bash -s -- "$REMOTE_REPO" <<'REMOTE'
set -euo pipefail
repo="$1"
printf 'branch=%s head=%s status_lines=%s' \
  "$(git -C "$repo" branch --show-current)" \
  "$(git -C "$repo" rev-parse --short=12 HEAD)" \
  "$(git -C "$repo" status --porcelain=v1 --untracked-files=all | wc -l | tr -d ' ')"
REMOTE
)"
  printf '[garrison-remote] post-session canonical VM state: %s\n' "$remote_state"
  printf '[garrison-remote] if Claude changed code, commit and push it on the VM, then fetch and fast-forward the Mac before editing locally again.\n'
  return "$resume_status"
}

verify_clean_release_source() {
  validate_configuration
  reject_ambiguous_git_state
  [ "$(git -C "$REPO_ROOT" branch --show-current)" = main ] \
    || die "production deploys require local main"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ] \
    || die "production deploys require a completely clean local worktree"

  git -C "$REPO_ROOT" fetch --quiet origin main
  [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = \
    "$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)" ] \
    || die "local main must exactly match freshly fetched origin/main"
}

deploy_prod() {
  local confirmation="${1:-}"
  [ "$confirmation" = deploy-garrison-prod ] \
    || die "production is disruptive; pass the exact confirmation: deploy-garrison-prod"
  require_canonical_mutation_repo

  verify_clean_release_source
  verify_remote_identity
  local expected_head
  expected_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"

  printf '[garrison-remote] release-checking %s in a temporary VM snapshot\n' \
    "${expected_head:0:12}"
  run_snapshot_action release

  # Editing, committing, or an upstream push during the release checks makes
  # their result stale. Re-read every local release invariant before touching
  # the canonical VM checkout.
  verify_clean_release_source
  [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$expected_head" ] \
    || die "local HEAD changed during release checks; retry the deploy"

  printf '[garrison-remote] release checks passed; beginning disruptive prod redeploy\n'
  local deploy_status=0
  ssh_exec flock \
    --close \
    --conflict-exit-code 75 \
    --nonblock \
    "$REMOTE_LOCK" \
    bash -s -- \
    "$REMOTE_REPO" \
    "$EXPECTED_ORIGIN" \
    "$expected_head" <<'REMOTE' || deploy_status=$?
set -euo pipefail
repo="$1"
expected_origin="$2"
expected_head="$3"

cd "$repo"
[ "$(git remote get-url origin)" = "$expected_origin" ]
[ "$(git branch --show-current)" = main ]
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] \
  || { printf '[garrison-remote] canonical VM worktree is changed; refusing deploy\n' >&2; exit 1; }
[ -z "$(git ls-files -u)" ]
[ -z "$(git ls-files -v | awk 'substr($0,1,1) ~ /[a-z]/ {print; exit}')" ]
[ -z "$(git ls-files -t | awk '$1 == "S" {print; exit}')" ]

git fetch --quiet origin main
[ "$(git rev-parse refs/remotes/origin/main)" = "$expected_head" ] \
  || { printf '[garrison-remote] origin/main changed after release checks; retry deploy\n' >&2; exit 1; }
git merge --ff-only refs/remotes/origin/main
[ "$(git rev-parse HEAD)" = "$expected_head" ]

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 20 --silent >/dev/null
fi
command -v node >/dev/null 2>&1
command -v npm >/dev/null 2>&1

printf '[garrison-remote] installing exact root and fitting lockfiles on the canonical VM\n'
npm_config_audit=false npm_config_fund=false npm ci --prefer-offline
while IFS= read -r -d '' lockfile; do
  fitting_path="${lockfile%/package-lock.json}"
  [ -f "$fitting_path/package.json" ]
  (
    cd "$fitting_path"
    npm_config_audit=false npm_config_fund=false npm ci --prefer-offline
  )
done < <(find "$repo/fittings/seed" \
  -mindepth 2 \
  -maxdepth 2 \
  -type f \
  -name package-lock.json \
  -print0)

[ "$(git rev-parse HEAD)" = "$expected_head" ]
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] \
  || { printf '[garrison-remote] canonical VM worktree changed during deploy preparation\n' >&2; exit 1; }
git fetch --quiet origin main
[ "$(git rev-parse refs/remotes/origin/main)" = "$expected_head" ] \
  || { printf '[garrison-remote] origin/main changed during deploy preparation; retry\n' >&2; exit 1; }

npm run prod:redeploy
[ "$(git rev-parse HEAD)" = "$expected_head" ]
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] \
  || { printf '[garrison-remote] canonical VM worktree changed during redeploy\n' >&2; exit 1; }
systemctl --user is-active --quiet garrison-prod.service
curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:8777/api/compositions
printf '[garrison-remote] prod now serves %s\n' "${expected_head:0:12}"
REMOTE
  if [ "$deploy_status" -eq 75 ]; then
    die "another snapshot/deploy command is active on dev-madrid"
  fi
  [ "$deploy_status" -eq 0 ] || return "$deploy_status"
}

if [ "${GARRISON_REMOTE_DEV_SOURCE_ONLY:-}" = 1 ]; then
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    return 0
  fi
  exit 0
fi

command_name="${1:-help}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command_name" in
  help|-h|--help) usage ;;
  doctor) doctor ;;
  plan) plan_snapshot ;;
  prod-status) prod_status ;;
  typecheck|test|check|build|preview|shell)
    run_snapshot_action "$command_name" "$@"
    ;;
  run)
    if [ "${1:-}" = -- ]; then shift; fi
    [ "$#" -gt 0 ] || die "run requires a command after --"
    run_snapshot_action run "$@"
    ;;
  resume) resume_session "${1:-}" "${2:-}" ;;
  deploy) deploy_prod "${1:-}" ;;
  *) usage >&2; die "unknown command: $command_name" ;;
esac
