#!/usr/bin/env bash
# Deploy the state service from a PINNED TAG — never from the working branch.
# A node branch merging badly must not be able to take shared state with it.
#
#   services/state/scripts/deploy.sh state-v1
#
# git archive, NOT a worktree: archive cannot create a branch, cannot be
# disturbed by gc/prune in the working checkout, and leaves a frozen export.
set -euo pipefail

TAG="${1:?usage: deploy.sh <tag>}"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
STATE_HOME="${GARRISON_STATE_HOME:-$HOME/.garrison-state}"
RELEASE_DIR="$STATE_HOME/releases/$TAG"

if ! git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "deploy: tag $TAG does not exist in $REPO_DIR" >&2
  exit 1
fi

mkdir -p "$RELEASE_DIR"
git -C "$REPO_DIR" archive "$TAG" services/state | tar -x -C "$RELEASE_DIR" --strip-components=2
(cd "$RELEASE_DIR" && npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent)
echo "$TAG" > "$RELEASE_DIR/VERSION"

ln -sfn "$RELEASE_DIR" "$STATE_HOME/current.next"
mv -T "$STATE_HOME/current.next" "$STATE_HOME/current"

if systemctl --user is-enabled garrison-state.service >/dev/null 2>&1; then
  systemctl --user restart garrison-state.service
  echo "deploy: $TAG live (unit restarted)"
else
  echo "deploy: $TAG staged at $STATE_HOME/current (unit not installed yet)"
fi
