#!/usr/bin/env bash
# Runs one command inside a temporary Garrison snapshot on dev-madrid.
# This file is invoked by scripts/remote-dev.sh; it is not a standalone sync
# mechanism and it must never point at the live canonical checkout.

set -euo pipefail
IFS=$'\n\t'
umask 077

die() {
  printf '[garrison-remote] %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || die "required environment variable is missing: $name"
}

require_env GARRISON_REMOTE_STAGE
require_env GARRISON_REMOTE_CACHE
require_env GARRISON_REMOTE_CANONICAL
require_env GARRISON_REMOTE_EXPECTED_HEAD

STAGE="$GARRISON_REMOTE_STAGE"
CACHE="$GARRISON_REMOTE_CACHE"
CANONICAL="$GARRISON_REMOTE_CANONICAL"
EXPECTED_HEAD="$GARRISON_REMOTE_EXPECTED_HEAD"
ROOT="$STAGE/repo"
LOCK_PATH="/tmp/garrison-mac-remote-dev.lock"
PREVIEW_PORT=27777
REAL_USER_HOME="$HOME"
SNAPSHOT_VAULT_TEST_KEY="garrison-remote-snapshot-$EXPECTED_HEAD"

STAGE_PARENT="${STAGE%/*}"
STAGE_BASENAME="${STAGE##*/}"
[ "$STAGE_PARENT" = "$CACHE/stages" ] \
  || die "refusing an unexpected stage parent: $STAGE"
[[ "$STAGE_BASENAME" =~ ^stage\.[A-Za-z0-9]{8}$ ]] \
  || die "refusing an unexpected stage name: $STAGE"
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] \
  || die "temporary stage is missing or is a symlink: $STAGE"
[ "$(realpath "$STAGE")" = "$STAGE" ] \
  || die "temporary stage did not resolve exactly: $STAGE"

[ -d "$ROOT/.git" ] || die "temporary snapshot is not a Git checkout: $ROOT"
[ "$(git -C "$ROOT" rev-parse --show-toplevel)" = "$ROOT" ] \
  || die "temporary snapshot root did not resolve exactly"
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$EXPECTED_HEAD" ] \
  || die "temporary snapshot is not at the requested commit"
[ "$(git -C "$ROOT" remote get-url origin)" = "$CANONICAL" ] \
  || die "temporary snapshot has an unexpected origin"
[ "$(git -C "$ROOT" remote get-url --push origin)" = /dev/null ] \
  || die "temporary snapshot push protection is missing"

load_node() {
  # Non-login SSH sessions on this VM intentionally do not inherit nvm.
  local real_home="$HOME"
  export NVM_DIR="$real_home/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use 20 --silent >/dev/null
  fi

  command -v node >/dev/null 2>&1 || die "Node.js is unavailable on the VM"
  command -v npm >/dev/null 2>&1 || die "npm is unavailable on the VM"
  unset NVM_DIR
}

prepare_dependencies() {
  printf '[garrison-remote] installing exact dependencies in the isolated snapshot\n'
  (
    cd "$ROOT"
    GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY" \
      npm_config_audit=false npm_config_fund=false npm ci --prefer-offline
  )
  printf 'isolated-install\n' > "$STAGE/dependencies.mode"

  # Several fitting packages intentionally own their dependency lockfile and
  # node_modules (Drill's browser picker is one example). Install every tracked
  # nested lockfile independently, still below the disposable snapshot.
  local lockfile relative_dir snapshot_dir
  while IFS= read -r -d '' lockfile; do
    snapshot_dir="${lockfile%/package-lock.json}"
    relative_dir="${snapshot_dir#"$ROOT/"}"
    [ -f "$snapshot_dir/package.json" ] \
      || die "fitting lockfile has no package.json: $relative_dir"
    printf '[garrison-remote] installing isolated dependencies for %s\n' "$relative_dir"
    (
      cd "$snapshot_dir"
      GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY" \
        npm_config_audit=false npm_config_fund=false npm ci --prefer-offline
    )
  done < <(find "$ROOT/fittings/seed" \
    -mindepth 2 \
    -maxdepth 2 \
    -type f \
    -name package-lock.json \
    -print0)
}

isolate_runtime_home() {
  # Tests and previews must not see ~/.garrison, ~/.garrison-dev, ~/.claude, or
  # any other user runtime state. The launcher supports these explicit
  # overrides; HOME itself is also isolated for code that uses homedir().
  local runtime_root="$STAGE/runtime"
  local isolated_home="$runtime_root/user-home"
  mkdir -p "$isolated_home"

  export HOME="$isolated_home"
  unset \
    GARRISON_INSTANCE_ID \
    GARRISON_HOME \
    GARRISON_HOME_OVERRIDE \
    GARRISON_CLAUDE_HOME \
    GARRISON_CLAUDE_HOME_OVERRIDE \
    GARRISON_APP_PORT \
    GARRISON_OUTPOST_PORT \
    GARRISON_SCHEDULER_HEALTH_PORT \
    GARRISON_BIND_HOST \
    GARRISON_BIND_HOST_OVERRIDE \
    GARRISON_VAULT_TEST_KEY \
    CLAUDE_CONFIG_DIR \
    CODEX_HOME \
    XDG_CONFIG_HOME \
    XDG_DATA_HOME \
    XDG_CACHE_HOME
  mkdir -p "$CACHE/npm-cache"
  : > "$STAGE/npmrc.empty"
  export npm_config_cache="$CACHE/npm-cache"
  export npm_config_userconfig="$STAGE/npmrc.empty"
  # Direct tests, shells, and arbitrary commands reuse the VM's authoritative
  # browser payloads while keeping profiles/config under the disposable HOME.
  # garrison-instance.sh deliberately replaces this for its codex profile;
  # build/preview do not launch a browser fitting.
  export PLAYWRIGHT_BROWSERS_PATH="$REAL_USER_HOME/.cache/ms-playwright"
  export PATH="$ROOT/node_modules/.bin:$REAL_USER_HOME/.local/bin:$REAL_USER_HOME/.bun/bin:$PATH"
}

run_codex_profile() {
  GARRISON_HOME_OVERRIDE="$HOME/.garrison-codex" \
  GARRISON_CLAUDE_HOME_OVERRIDE="$HOME/.claude-garrison-codex" \
  GARRISON_APP_PORT="$PREVIEW_PORT" \
  GARRISON_BIND_HOST_OVERRIDE=127.0.0.1 \
  GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY" \
    bash scripts/garrison-instance.sh codex "$@"
}

run_tests() {
  # Vitest owns its test-ephemeral vault identity. An explicit key changes the
  # behavior that tests/vault.test.ts is designed to verify.
  unset GARRISON_VAULT_TEST_KEY
  if [ "$#" -gt 0 ]; then
    CI=1 npm test -- "$@"
  else
    CI=1 npm test
  fi
}

lock_snapshot() {
  command -v flock >/dev/null 2>&1 || die "flock is unavailable on the VM"
  if [ "${GARRISON_REMOTE_LOCK_HELD:-}" = 1 ]; then
    return
  fi

  # Let flock supervise a fresh runner. --close keeps its descriptor out of
  # test/server children, so a failed command cannot leave the workflow locked
  # after the supervising runner exits.
  local status=0
  GARRISON_REMOTE_LOCK_HELD=1 \
    flock --close --conflict-exit-code 75 --nonblock "$LOCK_PATH" \
      bash "$0" "$@" || status=$?
  if [ "$status" -eq 75 ]; then
    die "another Mac snapshot command is already running on dev-madrid"
  fi
  exit "$status"
}

run_preview() {
  local listener preview_pid=0 exit_code=0

  if ss -H -ltn | awk -v suffix=":$PREVIEW_PORT" '$4 ~ (suffix "$") { found=1 } END { exit !found }'; then
    die "port $PREVIEW_PORT is already in use; refusing to disturb that process"
  fi

  cleanup_preview() {
    if [ "$preview_pid" -gt 0 ] && kill -0 "$preview_pid" 2>/dev/null; then
      kill -TERM "$preview_pid" 2>/dev/null || true
      wait "$preview_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_preview EXIT INT TERM

  printf '[garrison-remote] starting isolated codex preview on VM loopback:%s\n' "$PREVIEW_PORT"
  run_codex_profile next &
  preview_pid=$!

  local attempt=0
  while [ "$attempt" -lt 90 ]; do
    attempt=$((attempt + 1))
    if ! kill -0 "$preview_pid" 2>/dev/null; then
      wait "$preview_pid" || exit_code=$?
      die "preview exited before opening its loopback listener (status $exit_code)"
    fi

    listener="$(ss -H -ltn | awk -v suffix=":$PREVIEW_PORT" '$4 ~ (suffix "$") { print $4; exit }')"
    if [ -n "$listener" ]; then
      case "$listener" in
        127.0.0.1:"$PREVIEW_PORT")
          printf '[garrison-remote] preview is ready; keep this command open while using it\n'
          break
          ;;
        *)
          die "preview opened a non-loopback listener ($listener); it has been stopped"
          ;;
      esac
    fi
    sleep 1
  done

  [ -n "${listener:-}" ] || die "preview did not open port $PREVIEW_PORT within 90 seconds"
  wait "$preview_pid" || exit_code=$?
  preview_pid=0
  trap - EXIT INT TERM
  return "$exit_code"
}

action="${1:-}"
[ -n "$action" ] || die "no remote action was supplied"
shift || true

load_node
lock_snapshot "$action" "$@"
isolate_runtime_home
prepare_dependencies
cd "$ROOT"

case "$action" in
  typecheck)
    GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY" CI=1 npm run typecheck
    ;;
  test)
    run_tests "$@"
    ;;
  check)
    GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY" CI=1 npm run typecheck
    run_tests
    ;;
  build)
    CI=1 run_codex_profile build
    ;;
  release)
    GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY" CI=1 npm run typecheck
    run_tests
    CI=1 run_codex_profile build
    ;;
  preview)
    run_preview
    ;;
  shell)
    export GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY"
    export PS1='[garrison snapshot on dev-madrid] \w \\$ '
    exec bash --noprofile --norc
    ;;
  run)
    [ "$#" -gt 0 ] || die "run requires a command after --"
    export GARRISON_VAULT_TEST_KEY="$SNAPSHOT_VAULT_TEST_KEY"
    exec "$@"
    ;;
  *)
    die "unsupported remote action: $action"
    ;;
esac
