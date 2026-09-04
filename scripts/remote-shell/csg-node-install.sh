#!/usr/bin/env bash
# csg-node-install.sh - dev-madrid-side G7 orchestrator: turns a GO/GO-WITH-
# FIXES preflight verdict into an actual csg install. Run FROM dev-madrid.
#
# The two operations here that mutate THIS machine's own SSH access control
# (~/.ssh/authorized_keys, ~/.ssh/config) are exposed as their own idempotent,
# independently-testable subcommands, so their exact formatting and safety
# checks (malformed-key refusal, never truncating, never duplicating) are
# proven against SCRATCH files before this script ever touches the real ones
# - see tests/csg-node-install.test.ts. The full `install` flow below is
# everything else the plan specifies; it is deliberately NOT exercised by any
# test (it needs a live, reachable csg to mean anything at all), and refuses
# to run at all unless the most recent preflight evidence says GO or
# GO-WITH-FIXES, so a stale/NO-GO state can never be driven through by
# accident.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

say() { printf '[csg-node-install] %s\n' "$*"; }

# ── append_authorized_key: the security-sensitive primitive ────────────────
# $1 = full public key line ("ssh-ed25519 AAAA... [comment]")
# $2 = target authorized_keys path
# $3 = repo dir the forced command restricts git operations to
append_authorized_key() {
  local pubkey_line="$1" akpath="$2" repo_dir="$3"
  local ptype pdata marker entry

  ptype="$(printf '%s' "$pubkey_line" | awk '{print $1}')"
  pdata="$(printf '%s' "$pubkey_line" | awk '{print $2}')"
  if [ -z "$ptype" ] || [ -z "$pdata" ]; then
    echo "append_authorized_key: refused - malformed public key line" >&2
    return 1
  fi
  case "$ptype" in
    ssh-ed25519|ssh-rsa|ecdsa-sha2-*|sk-ssh-ed25519@openssh.com) ;;
    *) echo "append_authorized_key: refused - unrecognised key type '$ptype'" >&2; return 1 ;;
  esac

  marker="garrison-csg-tether"
  entry="from=\"127.0.0.1\",no-pty,no-agent-forwarding,no-X11-forwarding,no-port-forwarding,command=\"$repo_dir/scripts/remote-shell/git-only-shell.sh\" $ptype $pdata $marker"

  mkdir -p "$(dirname "$akpath")"
  touch "$akpath"
  chmod 600 "$akpath"

  # Idempotent on the KEY MATERIAL, not the whole line (a repo_dir change
  # would otherwise duplicate the entry for the same key).
  if grep -qF "$pdata" "$akpath" 2>/dev/null; then
    say "append_authorized_key: an entry for this key already exists in $akpath - left untouched"
    return 0
  fi

  printf '%s\n' "$entry" >> "$akpath"
  chmod 600 "$akpath"
  say "append_authorized_key: appended to $akpath (marker: $marker)"
}

# ── append_ssh_config_host: the second file-mutating primitive ─────────────
# $1 = host alias, $2 = the Host block body (without the "Host <alias>" line
# itself - each line gets indented two spaces), $3 = ssh config path
append_ssh_config_host() {
  local alias_name="$1" body="$2" cfgpath="$3"

  mkdir -p "$(dirname "$cfgpath")"
  touch "$cfgpath"
  chmod 600 "$cfgpath"

  if grep -qx "Host $alias_name" "$cfgpath" 2>/dev/null; then
    say "append_ssh_config_host: Host $alias_name already present in $cfgpath - left untouched"
    return 0
  fi

  {
    echo ""
    echo "Host $alias_name"
    printf '%s\n' "$body" | sed 's/^/  /'
  } >> "$cfgpath"
  say "append_ssh_config_host: appended Host $alias_name to $cfgpath"
}

# ── latest_preflight_verdict: the safety gate for the real install flow ────
latest_preflight_verdict() {
  local dir="$REPO_ROOT/evidence/shells/csg"
  local latest
  latest="$(ls -1 "$dir"/preflight-*.json 2>/dev/null | sort | tail -n1 || true)"
  if [ -z "$latest" ]; then
    echo "none"
    return
  fi
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).verdict||"unknown")}catch{console.log("unreadable")}})' < "$latest"
}

# ── the real orchestration (needs a live, reachable csg) ────────────────────
do_install() {
  local verdict
  verdict="$(latest_preflight_verdict)"
  case "$verdict" in
    GO|GO-WITH-FIXES) say "latest preflight verdict: $verdict - proceeding" ;;
    *)
      echo "refusing to install: latest csg preflight verdict is '$verdict', not GO/GO-WITH-FIXES." >&2
      echo "run: node scripts/remote-shell/csg-node-preflight.mjs" >&2
      exit 1
      ;;
  esac

  local TETHER_HOST="dev-madrid"
  local APP_ORIGIN="https://dev-madrid.tail31efa.ts.net:8977"
  local SHELL_ORIGIN="https://dev-madrid.tail31efa.ts.net:8998"
  local STATE_URL="http://127.0.0.1:8460"
  local CSG_SSH_HOST="127.0.0.1"
  local CSG_SSH_PORT="2222"
  local CSG_SSH_USER="ggomes"
  local CSG_SSH_IDENTITY="$HOME/.ssh/garrison-remote-shell"
  # The SAME transport 2222 the legacy csg entry and the tether already use -
  # this script never dials a second devtunnel client.
  local CSG="ssh -p $CSG_SSH_PORT -i $CSG_SSH_IDENTITY -o BatchMode=yes -o StrictHostKeyChecking=accept-new $CSG_SSH_USER@$CSG_SSH_HOST"

  say "step 1/9: tether key on csg (idempotent)"
  # shellcheck disable=SC2086
  $CSG 'test -f ~/.ssh/garrison-tether || ssh-keygen -t ed25519 -N "" -f ~/.ssh/garrison-tether -q -C garrison-csg-tether'
  # shellcheck disable=SC2086
  local pubkey
  pubkey="$($CSG 'cat ~/.ssh/garrison-tether.pub')"

  say "step 2/9: dev-madrid authorized_keys entry"
  append_authorized_key "$pubkey" "$HOME/.ssh/authorized_keys" "$REPO_ROOT"

  say "step 3/9: dev-madrid ~/.ssh/config Host csg alias"
  append_ssh_config_host "csg" "$(cat <<CFG
HostName $CSG_SSH_HOST
Port $CSG_SSH_PORT
User $CSG_SSH_USER
IdentityFile $CSG_SSH_IDENTITY
BatchMode yes
StrictHostKeyChecking accept-new
CFG
)" "$HOME/.ssh/config"

  say "step 4/9: issuing csg's mesh token"
  local TOKEN
  TOKEN="$(cd "$REPO_ROOT/services/state" && node scripts/issue-node-token.mjs csg --accent steel --platform linux)"

  say "step 5/9: copying install-node.sh to csg:/tmp"
  # shellcheck disable=SC2086
  scp -P "$CSG_SSH_PORT" -i "$CSG_SSH_IDENTITY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "$REPO_ROOT/scripts/install-node.sh" "$CSG_SSH_USER@$CSG_SSH_HOST:/tmp/install-node.sh"

  say "step 6/9: ensuring node is available on csg (nvm install --lts if missing - the preflight already flags when this is needed)"
  # shellcheck disable=SC2086
  $CSG 'bash -s' <<'REMOTE'
set -e
if command -v node >/dev/null 2>&1; then
  echo "node already present: $(node --version)"
  exit 0
fi
if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
  echo "node is missing on csg and nvm is not available - cannot bootstrap" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$HOME/.nvm/nvm.sh"
nvm install --lts
nvm alias default 'lts/*'
echo "node installed via nvm: $(node --version)"
REMOTE

  say "step 7/9: running install-node.sh --tethered on csg (token via stdin, never argv)"
  # A tiny wrapper, not a direct `bash /tmp/install-node.sh` call: `nvm
  # install` only updates PATH for a shell that SOURCES nvm.sh (typically via
  # .bashrc on an interactive login), which `bash /tmp/x.sh` never does - the
  # step above's freshly-installed node would otherwise be invisible to
  # install-node.sh's own preflight. Written via a separate ssh call (not a
  # heredoc on the SAME call as the token pipe below - a heredoc and a stdin
  # pipe can't both feed one command) so the token can still flow through
  # stdin untouched via a normal argv-based invocation of this wrapper.
  # shellcheck disable=SC2086
  # bash, not sh: nvm.sh's own sourcing-path detection relies on
  # BASH_SOURCE, which dash (Ubuntu's /bin/sh) does not have - sourcing it
  # from a plain #!/bin/sh wrapper derives the WRONG NVM_DIR (found live:
  # NVM_DIR ended up /usr/bin, from sh's own $0) and node never lands on PATH
  # even though nvm reports success.
  $CSG 'cat > /tmp/run-install-node.sh && chmod +x /tmp/run-install-node.sh' <<'REMOTE'
#!/bin/bash
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
fi
exec bash /tmp/install-node.sh "$@"
REMOTE
  # shellcheck disable=SC2086
  printf '%s\n' "$TOKEN" | $CSG "/tmp/run-install-node.sh --name csg --accent steel \
    --state-url $STATE_URL --token-stdin \
    --tethered --tether-host $TETHER_HOST --app-origin $APP_ORIGIN --shell-origin $SHELL_ORIGIN \
    --repo-source github"

  say "step 8/9: writing csg's compositions/default/local.yml"
  # shellcheck disable=SC2086
  scp -P "$CSG_SSH_PORT" -i "$CSG_SSH_IDENTITY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "$HERE/csg-local.yml.example" "$CSG_SSH_USER@$CSG_SSH_HOST:~/dev/garrison/compositions/default/local.yml"

  say "step 9/9: verifying csg answers through $APP_ORIGIN"
  for i in $(seq 1 15); do
    curl -sf -o /dev/null --max-time 5 "$APP_ORIGIN/api/mesh/self" && break
    sleep 3
  done
  curl -sf "$APP_ORIGIN/api/mesh/self" >/dev/null || {
    echo "FAILED: csg's /api/mesh/self never answered through $APP_ORIGIN" >&2
    exit 1
  }
  say "DONE: csg is installed and answering at $APP_ORIGIN"
  say "mirror-mode scheduler job (csg-branch-relay) and secret grants are NOT automated here - run them by hand per docs/decisions/2026-09-03-shells-and-mesh-sessions.md section G6/G7 once this is confirmed stable"
}

# ── CLI ──────────────────────────────────────────────────────────────────
case "${1:-}" in
  append-authorized-key)
    # test/manual entrypoint: csg-node-install.sh append-authorized-key <pubkey-line> <path> <repo-dir>
    shift
    append_authorized_key "$1" "$2" "$3"
    ;;
  append-ssh-config-host)
    # test/manual entrypoint: csg-node-install.sh append-ssh-config-host <alias> <body> <path>
    shift
    append_ssh_config_host "$1" "$2" "$3"
    ;;
  latest-preflight-verdict)
    latest_preflight_verdict
    ;;
  install|"")
    do_install
    ;;
  *)
    echo "usage: csg-node-install.sh [install|append-authorized-key <pubkey-line> <path> <repo-dir>|append-ssh-config-host <alias> <body> <path>|latest-preflight-verdict]" >&2
    exit 2
    ;;
esac
