#!/usr/bin/env bash
# Reload PROD — build, restart the app server, and bring the operative back on the
# FAST PATH (no reinstall, no setup hooks, no 44 verify hooks).
#
# WHAT THIS IS NOT. It does not keep the operative alive across the restart: the
# gateway and the fittings are children of garrison-prod.service, so restarting the
# unit takes the whole cgroup down. That was measured, not assumed.
#
# WHERE THE SAVING ACTUALLY COMES FROM: up()'s composition fingerprint. When the
# manifest, the lockfile and the path-dependency trees are unchanged, `apm install`,
# every setup hook and every verify hook are provably redundant and are skipped —
# the operative is back in about two seconds instead of minutes. An app-only change
# never touches that fingerprint, which is exactly why this path is safe for it.
#
# USE THIS when the change is confined to the Next app:
#   src/app/**, src/components/**, src/lib/** (as imported by the app)
#
# USE prod:redeploy when the change alters what the fingerprint covers, so the
# reinstall/verify really is needed:
#   fittings/seed/**            (fitting servers, runtime adapters, the gateway)
#   packages/**                 (claude-pty, claude-chat)
#   compositions/*/apm.yml      (stationing, accounts, targets)
#
# Either way the fingerprint decides honestly: if something under the composition
# DID change, the up below takes the full path on its own. This script never skips
# verification that was needed — it declines to force verification that was not.
#
# Usage: scripts/garrison-reload.sh [composition-id]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROD_PORT="$(bash scripts/garrison-instance.sh prod env | sed -n 's/^GARRISON_APP_PORT=//p')"
BASE="http://127.0.0.1:${PROD_PORT}"
UNIT="garrison-prod.service"
LAUNCHD_LABEL="io.garrison.node"

say() { printf "\n[reload] %s\n" "$*"; }

# --- build ------------------------------------------------------------------
# Fail here and prod keeps serving the last good build, exactly as redeploy does.
say "building prod bundle (.next-prod)"
bash scripts/garrison-instance.sh prod build

# --- swap the app server ----------------------------------------------------
# Same OS detection as garrison-redeploy.sh: systemd user unit on Linux,
# launchd agent on macOS. The reload script predated the cross-OS redeploy
# (bd35e505) and silently only worked on Linux.
restart_supervised() {
  if command -v systemctl >/dev/null 2>&1 \
     && systemctl --user cat "$UNIT" >/dev/null 2>&1; then
    say "restarting $UNIT (systemd)"
    systemctl --user restart "$UNIT"
    return 0
  fi
  if command -v launchctl >/dev/null 2>&1 \
     && launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
    say "kickstarting $LAUNCHD_LABEL (launchd)"
    launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
    return 0
  fi
  return 1
}
if ! restart_supervised; then
  echo "[reload] no app supervisor found (systemd: $UNIT, launchd: $LAUNCHD_LABEL)." >&2
  echo "         Enroll this machine with scripts/install-node.sh, or start by hand:" >&2
  echo "         npm run prod:start" >&2
  exit 1
fi

# --- wait for it to answer --------------------------------------------------
say "waiting for $BASE"
ready=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 "$BASE/api/compositions"; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "[reload] $BASE did not come up within 60s — check: journalctl --user -u $UNIT -n 50" >&2
  exit 1
fi

# --- bring the operative back ------------------------------------------------
# The restart took it down with the unit. up() fingerprints the composition and
# skips install/setup/verify when nothing it covers changed, so for an app-only
# change this is seconds.
composition="${1:-}"
if [ -z "$composition" ]; then
  PROD_HOME="$(bash scripts/garrison-instance.sh prod env | sed -n 's/^GARRISON_HOME=//p')"
  composition="$(node -e '
    const fs=require("fs");
    try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1]+"/config.json","utf8")).active_composition || "default"); }
    catch { process.stdout.write("default"); }
  ' "$PROD_HOME")"
fi
say "starting operative ($composition) — fast path when the composition is unchanged"
if curl -sf -X POST --max-time 600 "$BASE/api/runner/$composition/up" -H 'content-type: application/json' -d '{}' >/dev/null; then
  say "done — app reloaded, operative running"
else
  echo "[reload] up failed — check the Run log at $BASE" >&2
  exit 1
fi
