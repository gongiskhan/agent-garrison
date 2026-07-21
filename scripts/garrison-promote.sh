#!/usr/bin/env bash
# Promote DEV -> PROD. This is what "faz commit" means.
#
# The two-tree model:
#
#   ~/dev/agent-garrison-dev   DEV tree   port 7777  ~/.garrison-dev   `npm run dev`
#   ~/dev/agent-garrison       PROD tree  port 8777  ~/.garrison       `npm start`
#
# All editing happens in the DEV tree. Prod's working copy is NEVER edited by
# hand — it only ever moves forward by fast-forwarding onto a dev commit. That
# is the whole point: a half-finished edit can't take the always-on surface
# down, because prod's files don't change until you say "commit".
#
# Both trees sit on the SAME branch (no dev-only branch exists, per CLAUDE.md's
# no-new-branches rule); dev is simply ahead. Promotion is therefore a plain
# fast-forward, and if it can't fast-forward something edited prod directly —
# which is a bug, so this script stops rather than merging.
#
# Steps:
#   1. commit every change in the dev tree
#   2. push to origin — ONLY with --push. "Commit" here means "land it on prod",
#      which is entirely local; publishing to GitHub is a separate decision and
#      must never be a silent side effect of deploying.
#   3. fast-forward prod onto the new dev commit
#   4. npm install in prod, but only if the lockfile actually moved
#   5. prod redeploy: build -> down -> restart -> up
#
# Usage: scripts/garrison-promote.sh "commit message"
#        scripts/garrison-promote.sh --push "commit message"   # also push to GitHub
#        scripts/garrison-promote.sh --deploy-only     # prod already has it; just redeploy

set -euo pipefail

DEV_TREE="${GARRISON_DEV_TREE:-$HOME/dev/agent-garrison-dev}"
PROD_TREE="${GARRISON_PROD_TREE:-$HOME/dev/agent-garrison}"

push=0
deploy_only=0
message=""
while [ $# -gt 0 ]; do
  case "$1" in
    --push) push=1; shift ;;
    --no-push) push=0; shift ;;
    --deploy-only) deploy_only=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) message="$1"; shift ;;
  esac
done

say()  { printf "\n[promote] %s\n" "$*"; }
die()  { printf "\n[promote] ERROR: %s\n" "$*" >&2; exit 1; }

[ -d "$DEV_TREE/.git" ]  || die "dev tree not found at $DEV_TREE"
[ -d "$PROD_TREE/.git" ] || die "prod tree not found at $PROD_TREE"

dev_branch="$(git -C "$DEV_TREE" rev-parse --abbrev-ref HEAD)"
prod_branch="$(git -C "$PROD_TREE" rev-parse --abbrev-ref HEAD)"
[ "$dev_branch" = "$prod_branch" ] \
  || die "dev is on '$dev_branch' but prod is on '$prod_branch' — they must match"

if [ "$deploy_only" = 0 ]; then
  [ -n "$message" ] || die "a commit message is required: garrison-promote.sh \"what changed\""

  # --- 1. commit in dev ------------------------------------------------------
  if [ -n "$(git -C "$DEV_TREE" status --porcelain)" ]; then
    say "committing in dev: $message"
    git -C "$DEV_TREE" add -A
    git -C "$DEV_TREE" commit -q -m "$message"
    git -C "$DEV_TREE" --no-pager log --oneline -1
  else
    say "dev working tree is clean — nothing new to commit"
  fi

  # --- 2. push (best-effort) -------------------------------------------------
  if [ "$push" = 1 ]; then
    say "pushing $dev_branch to origin"
    git -C "$DEV_TREE" push origin "$dev_branch" \
      || echo "[promote] push failed (offline?) — continuing with the local deploy"
  fi
fi

# --- 3. fast-forward prod ----------------------------------------------------
dev_head="$(git -C "$DEV_TREE" rev-parse HEAD)"
prod_head="$(git -C "$PROD_TREE" rev-parse HEAD)"

if [ "$dev_head" = "$prod_head" ]; then
  say "prod is already at $(git -C "$PROD_TREE" rev-parse --short HEAD) — redeploying only"
else
  # Prod's working copy must be pristine. If it isn't, someone edited prod
  # directly; fast-forwarding would silently destroy that work.
  if [ -n "$(git -C "$PROD_TREE" status --porcelain)" ]; then
    git -C "$PROD_TREE" --no-pager status --short >&2
    die "prod tree has local edits (above). Prod is read-only — move that work to $DEV_TREE and retry."
  fi

  lock_before="$(git -C "$PROD_TREE" rev-parse HEAD:package-lock.json 2>/dev/null || echo none)"

  say "fast-forwarding prod onto $(git -C "$DEV_TREE" rev-parse --short HEAD)"
  git -C "$PROD_TREE" fetch --quiet dev "$dev_branch"
  git -C "$PROD_TREE" merge --ff-only FETCH_HEAD \
    || die "prod could not fast-forward — its history diverged from dev"

  # --- 4. npm install only if the lockfile moved -----------------------------
  lock_after="$(git -C "$PROD_TREE" rev-parse HEAD:package-lock.json 2>/dev/null || echo none)"
  if [ "$lock_before" != "$lock_after" ]; then
    say "package-lock.json changed — installing deps in prod"
    (cd "$PROD_TREE" && npm install)
  else
    say "dependencies unchanged — skipping npm install"
  fi
fi

# --- 5. redeploy -------------------------------------------------------------
say "redeploying prod"
bash "$PROD_TREE/scripts/garrison-redeploy.sh"

say "landed: $(git -C "$PROD_TREE" --no-pager log --oneline -1)"
