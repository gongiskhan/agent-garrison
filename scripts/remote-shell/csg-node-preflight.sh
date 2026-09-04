#!/bin/sh
# csg-node-preflight.sh - runs ON csg, over `ssh ... bash -s` (piped via
# stdin, never scp'd first - this script never touches disk on csg unless
# explicitly asked to write evidence). Read-only: it inspects, it never
# installs, enables, or deletes anything. Prints exactly ONE JSON object on
# stdout; csg-node-preflight.mjs (the dev-madrid runner) combines this with
# its OWN local checks (tunnel state, round-trip timing, clock skew against
# ITS clock) to produce the GO/GO-WITH-FIXES/NO-GO verdict - this script
# alone never renders a verdict, since half the inputs (tunnel/ssh reachability
# from dev-madrid's side) are not observable from here.
#
# POSIX sh throughout (not bash) - `sh -s` is the plan's own invocation, and
# this must run correctly even if csg's default shell or a WSL quirk makes
# bash unavailable in a login-less non-interactive session.
set -u

# ── tiny JSON helpers (no dependency on node/jq existing - that is itself
# one of the things being checked) ───────────────────────────────────────────
jstr() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'; }
jbool() { [ "$1" = "1" ] && printf 'true' || printf 'false'; }
jnum() { if [ -n "${1:-}" ] && [ "$1" != "null" ]; then printf '%s' "$1"; else printf 'null'; fi; }
# A JSON string, or the literal `null` when the value is empty/absent.
jstrn() { if [ -n "${1:-}" ]; then printf '"%s"' "$(jstr "$1")"; else printf 'null'; fi; }

ok() { command -v "$1" >/dev/null 2>&1 && echo 1 || echo 0; }

# ── pid1 / WSL2 / systemd ────────────────────────────────────────────────────
WSL2=0
if [ -r /proc/version ] && grep -qi "microsoft" /proc/version 2>/dev/null; then WSL2=1; fi
PID1_COMM="$(cat /proc/1/comm 2>/dev/null || echo unknown)"
SYSTEMD_SYSTEM=0
[ -d /run/systemd/system ] && SYSTEMD_SYSTEM=1
SYSTEMD_USER_OK=0
if systemctl --user status >/dev/null 2>&1; then SYSTEMD_USER_OK=1; fi

# ── node / npm ────────────────────────────────────────────────────────────
NODE_VERSION=""
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null | tr -d 'v')"
  # >= 20.11, compared as major.minor without relying on `sort -V` (not on
  # every minimal image).
  NMAJ="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"
  NMIN="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"
  if [ -n "$NMAJ" ] && [ "$NMAJ" -gt 20 ] 2>/dev/null; then NODE_OK=1
  elif [ "${NMAJ:-0}" = "20" ] && [ -n "$NMIN" ] && [ "$NMIN" -ge 11 ] 2>/dev/null; then NODE_OK=1
  fi
fi
NVM_AVAILABLE=0
[ -s "$HOME/.nvm/nvm.sh" ] && NVM_AVAILABLE=1
NPM_PING_OK=0
if command -v npm >/dev/null 2>&1; then
  npm ping --silent >/dev/null 2>&1 && NPM_PING_OK=1
fi

# ── git ───────────────────────────────────────────────────────────────────
GIT_VERSION=""
GIT_OK=0
if command -v git >/dev/null 2>&1; then
  GIT_VERSION="$(git --version 2>/dev/null | awk '{print $3}')"
  GMAJ="$(printf '%s' "$GIT_VERSION" | cut -d. -f1)"
  GMIN="$(printf '%s' "$GIT_VERSION" | cut -d. -f2)"
  if [ -n "$GMAJ" ] && [ "$GMAJ" -gt 2 ] 2>/dev/null; then GIT_OK=1
  elif [ "${GMAJ:-0}" = "2" ] && [ -n "$GMIN" ] && [ "$GMIN" -ge 30 ] 2>/dev/null; then GIT_OK=1
  fi
fi
GITHUB_REACHABLE=0
if command -v git >/dev/null 2>&1; then
  timeout 8 git ls-remote https://github.com/gongiskhan/agent-garrison.git main >/dev/null 2>&1 && GITHUB_REACHABLE=1
fi

# ── disk / memory / cpu ─────────────────────────────────────────────────────
DISK_AVAIL_GB=""
if command -v df >/dev/null 2>&1; then
  DISK_AVAIL_GB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{printf "%.1f", $4/1024/1024}')"
fi
MEM_TOTAL_GB=""
if [ -r /proc/meminfo ]; then
  MEM_TOTAL_GB="$(awk '/MemTotal/{printf "%.1f", $2/1024/1024}' /proc/meminfo 2>/dev/null)"
fi
NPROC_N="$(nproc 2>/dev/null || echo "")"

# ── tool inventory ───────────────────────────────────────────────────────
TOOLS_JSON="{"
FIRST=1
for t in tmux python3 curl ssh gcc make g++ sqlite3 claude codex gemini cursor-agent devtunnel code; do
  [ "$FIRST" = 1 ] || TOOLS_JSON="${TOOLS_JSON},"
  FIRST=0
  TOOLS_JSON="${TOOLS_JSON}\"$(jstr "$t")\":$(jbool "$(ok "$t")")"
done
TOOLS_JSON="${TOOLS_JSON}}"

# ── sudo ──────────────────────────────────────────────────────────────────
SUDO_PRESENT=0
command -v sudo >/dev/null 2>&1 && SUDO_PRESENT=1
SUDO_NOPASSWD=0
[ "$SUDO_PRESENT" = 1 ] && sudo -n true >/dev/null 2>&1 && SUDO_NOPASSWD=1

# ── sshd AllowTcpForwarding (the tether's -R/-L legs die silently without
# this, so it is a NO-GO condition, not a fix-later one) ────────────────────
SSHD_ALLOW_FWD="unknown"
if command -v sshd >/dev/null 2>&1; then
  SSHD_T="$(sudo -n sshd -T 2>/dev/null || sshd -T 2>/dev/null || true)"
  if [ -n "$SSHD_T" ]; then
    VAL="$(printf '%s\n' "$SSHD_T" | awk 'tolower($1)=="allowtcpforwarding"{print tolower($2); exit}')"
    case "$VAL" in
      yes|all) SSHD_ALLOW_FWD="yes" ;;
      no) SSHD_ALLOW_FWD="no" ;;
      "") SSHD_ALLOW_FWD="unknown" ;;
      *) SSHD_ALLOW_FWD="$VAL" ;;
    esac
  fi
fi

# ── proxy env ─────────────────────────────────────────────────────────────
PROXY_JSON="{"
FIRST=1
for v in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY; do
  eval "VAL=\${$v:-}"
  if [ -n "$VAL" ]; then
    [ "$FIRST" = 1 ] || PROXY_JSON="${PROXY_JSON},"
    FIRST=0
    PROXY_JSON="${PROXY_JSON}\"$(jstr "$v")\":\"$(jstr "$VAL")\""
  fi
done
PROXY_JSON="${PROXY_JSON}}"

# ── clock (dev-madrid computes skew - this only reports its own UTC time) ──
REMOTE_TIME_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")"

# ── VS Code tunnel + the retiring peaceful-ocean host, on THIS box ──────────
CODE_TUNNEL_PRESENT=0
command -v code >/dev/null 2>&1 && CODE_TUNNEL_PRESENT=1
PEACEFUL_OCEAN_RUNNING=0
if pgrep -f "devtunnel host.*peaceful-ocean" >/dev/null 2>&1 || pgrep -f "host-tunnel.sh.*peaceful-ocean" >/dev/null 2>&1; then
  PEACEFUL_OCEAN_RUNNING=1
fi

# ── the checkout target ─────────────────────────────────────────────────────
REPO_DIR="$HOME/dev/garrison"
REPO_DIR_EXISTS=0
[ -d "$REPO_DIR" ] && REPO_DIR_EXISTS=1
REPO_DIR_IS_SYMLINK=0
[ -L "$REPO_DIR" ] && REPO_DIR_IS_SYMLINK=1

# ── ~/.cursor inventory (verbatim, for G7's before/after diff - PRESERVE,
# never modified by this script) ────────────────────────────────────────────
sha_or_empty() { [ -f "$1" ] && (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1" 2>/dev/null) | awk '{print $1}'; }

HOOKS_JSON_SHA="$(sha_or_empty "$HOME/.cursor/hooks.json")"
CLI_CONFIG_SHA="$(sha_or_empty "$HOME/.cursor/cli-config.json")"
MCP_JSON_SHA="$(sha_or_empty "$HOME/.cursor/mcp.json")"
CURSORRULES_SHA="$(sha_or_empty "$HOME/.cursorrules")"
PNMUI_AGENTS_MD=0
[ -f "$HOME/dev/pnmui-monorepo/AGENTS.md" ] && PNMUI_AGENTS_MD=1

list_hashes_json() {
  # $1 = find root, emits [{"path":"...","sha256":"..."}] for every *.mdc /
  # SKILL.md file under it, or [] if the root is absent.
  root="$1"
  [ -d "$root" ] || { printf '[]'; return; }
  printf '['
  first=1
  find "$root" -type f \( -name "*.mdc" -o -name "SKILL.md" \) 2>/dev/null | sort | while IFS= read -r f; do
    h="$(sha_or_empty "$f")"
    [ "$first" = 1 ] || printf ','
    first=0
    printf '{"path":"%s","sha256":"%s"}' "$(jstr "$f")" "$(jstr "$h")"
  done
  printf ']'
}
CURSOR_RULE_FILES_JSON="$(list_hashes_json "$HOME/.cursor")"
PNMUI_RULE_FILES_JSON="$(list_hashes_json "$HOME/dev/pnmui-monorepo/.cursor/rules")"

# ── emit ──────────────────────────────────────────────────────────────────
printf '{'
printf '"wsl2":%s,' "$(jbool "$WSL2")"
printf '"pid1Comm":%s,' "$(jstrn "$PID1_COMM")"
printf '"systemdSystem":%s,' "$(jbool "$SYSTEMD_SYSTEM")"
printf '"systemdUserOk":%s,' "$(jbool "$SYSTEMD_USER_OK")"
printf '"nodeVersion":%s,' "$(jstrn "$NODE_VERSION")"
printf '"nodeOk":%s,' "$(jbool "$NODE_OK")"
printf '"nvmAvailable":%s,' "$(jbool "$NVM_AVAILABLE")"
printf '"npmPingOk":%s,' "$(jbool "$NPM_PING_OK")"
printf '"gitVersion":%s,' "$(jstrn "$GIT_VERSION")"
printf '"gitOk":%s,' "$(jbool "$GIT_OK")"
printf '"githubReachable":%s,' "$(jbool "$GITHUB_REACHABLE")"
printf '"diskAvailGb":%s,' "$(jnum "$DISK_AVAIL_GB")"
printf '"memTotalGb":%s,' "$(jnum "$MEM_TOTAL_GB")"
printf '"nproc":%s,' "$(jnum "$NPROC_N")"
printf '"tools":%s,' "$TOOLS_JSON"
printf '"sudoPresent":%s,' "$(jbool "$SUDO_PRESENT")"
printf '"sudoNopasswd":%s,' "$(jbool "$SUDO_NOPASSWD")"
printf '"sshdAllowTcpForwarding":%s,' "$(jstrn "$SSHD_ALLOW_FWD")"
printf '"proxyEnv":%s,' "$PROXY_JSON"
printf '"remoteTimeIso":%s,' "$(jstrn "$REMOTE_TIME_ISO")"
printf '"codeTunnelPresent":%s,' "$(jbool "$CODE_TUNNEL_PRESENT")"
printf '"peacefulOceanHostRunning":%s,' "$(jbool "$PEACEFUL_OCEAN_RUNNING")"
printf '"repoDirExists":%s,' "$(jbool "$REPO_DIR_EXISTS")"
printf '"repoDirIsSymlink":%s,' "$(jbool "$REPO_DIR_IS_SYMLINK")"
printf '"cursorInventory":{'
printf '"hooksJsonSha256":%s,' "$(jstrn "$HOOKS_JSON_SHA")"
printf '"cliConfigJsonSha256":%s,' "$(jstrn "$CLI_CONFIG_SHA")"
printf '"mcpJsonSha256":%s,' "$(jstrn "$MCP_JSON_SHA")"
printf '"cursorrulesSha256":%s,' "$(jstrn "$CURSORRULES_SHA")"
printf '"pnmuiAgentsMdPresent":%s,' "$(jbool "$PNMUI_AGENTS_MD")"
printf '"ruleAndSkillFiles":%s,' "$CURSOR_RULE_FILES_JSON"
printf '"pnmuiRuleFiles":%s' "$PNMUI_RULE_FILES_JSON"
printf '}'
printf '}\n'
