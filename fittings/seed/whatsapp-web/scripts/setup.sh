#!/usr/bin/env bash
# whatsapp-web Fitting setup — runs from the Fitting's installed directory on
# every `up`, before verify (CLAUDE.md setup-vs-verify: side-effecting prep
# only, no network calls to WhatsApp, no pairing). Idempotent.
#
#   1. Check Node 20+.
#   2. npm install the Fitting's own deps (@whiskeysockets/baileys) — this
#      runs in the SAME directory the own-port daemon is started from
#      (fittings/seed/whatsapp-web on this host; see src/lib/runner.ts
#      runFittingSetup / src/lib/own-port-lifecycle.ts startOwnPortFitting,
#      which both resolve a local-path Fitting to its seed dir, not
#      apm_modules), so this is the one install that actually matters for the
#      running daemon.
#   3. Create session_dir (0700) OUTSIDE the repo tree and OUTSIDE
#      apm_modules — the Baileys auth/session state and the local message
#      store live there so a reinstall/`apm install` never wipes a paired
#      session. Never touches its contents if it already exists.
#   4. Report (non-blocking) whether the account is already paired.
#
# Never invoked here: pairing (scripts/pair.mjs) or starting the daemon
# (scripts/start.mjs) — both are explicit, human-triggered actions.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FITTING_DIR="$(cd "$HERE/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH; install Node.js 20+ and re-run" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".").shift()')"
if [ "$node_major" -lt 20 ]; then
  echo "node ${node_major} is too old; whatsapp-web needs 20+" >&2
  exit 1
fi

echo "[whatsapp-web:setup] installing deps in $FITTING_DIR"
(cd "$FITTING_DIR" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || npm install --no-audit --no-fund)

# Composition config reaches a SETUP hook as WHATSAPP_WEB_<KEY> (setupConfigEnv
# in src/lib/runner.ts prefixes with the fitting id, non-alphanumerics -> "_",
# upper-cased) — NOT the GARRISON_WHATSAPPWEB_<KEY> form the running daemon
# reads (ownPortConfigEnv). Same "~/" the shell does not expand for us.
SESSION_DIR_RAW="${WHATSAPP_WEB_SESSION_DIR:-~/.config/garrison/whatsapp-web}"
case "$SESSION_DIR_RAW" in
  "~/"*) SESSION_DIR="$HOME/${SESSION_DIR_RAW#\~/}" ;;
  "~")   SESSION_DIR="$HOME" ;;
  *)     SESSION_DIR="$SESSION_DIR_RAW" ;;
esac

mkdir -p "$SESSION_DIR"
chmod 700 "$SESSION_DIR" 2>/dev/null || true

if [ -f "$SESSION_DIR/auth/creds.json" ]; then
  readiness="paired — the daemon reconnects the existing session automatically"
else
  readiness="not paired yet — run \`node scripts/pair.mjs <phone number>\` after starting the daemon (see instructions.md)"
fi

echo "whatsapp-web setup ok (node ${node_major}; session dir: $SESSION_DIR; $readiness)"
