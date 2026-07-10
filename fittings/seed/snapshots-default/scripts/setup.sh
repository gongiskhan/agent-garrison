#!/usr/bin/env bash
# Snapshots Fitting setup: ensure restic is present and (best-effort) install the
# systemd USER timers that drive backups independently of Garrison. Idempotent -
# runs on every `up`; re-templating the unit ExecStart keeps it pointed at the
# current install path. Degrades honestly: a box that cannot install restic or
# lacks a systemd user session still completes setup with FOLLOWUP guidance.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/../systemd"

# 1. restic binary.
if ! command -v restic >/dev/null 2>&1; then
  echo "restic not found; attempting non-interactive install..."
  if command -v apt-get >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n apt-get install -y restic >/dev/null 2>&1 || true
  fi
fi
if ! command -v restic >/dev/null 2>&1; then
  echo "FOLLOWUP: restic could not be installed automatically. Install it with:"
  echo "    sudo apt-get install -y restic"
  echo "snapshots setup incomplete (restic missing); timers not installed."
  exit 0
fi
echo "restic present: $(restic version 2>/dev/null | head -1)"

# 2. systemd user timers - the Garrison-independent scheduling path.
if ! command -v systemctl >/dev/null 2>&1 || [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  echo "FOLLOWUP: no systemd user session detected; skipping timer install."
  echo "  Backups can still be taken on demand from the Snapshots view."
  echo "snapshots setup ok (on-demand only)"
  exit 0
fi

USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$USER_UNIT_DIR"

install_unit() {
  local name="$1"
  sed -e "s#__BACKUP_SCRIPT__#$SCRIPT_DIR/backup.sh#g" \
      -e "s#__PRUNE_SCRIPT__#$SCRIPT_DIR/prune.sh#g" \
      "$UNIT_SRC/$name" > "$USER_UNIT_DIR/$name"
}

for u in garrison-snapshots.service garrison-snapshots.timer \
         garrison-snapshots-prune.service garrison-snapshots-prune.timer; do
  install_unit "$u"
done

systemctl --user daemon-reload || true
if systemctl --user enable --now garrison-snapshots.timer garrison-snapshots-prune.timer >/dev/null 2>&1; then
  echo "installed + enabled garrison-snapshots.timer (daily 03:00) and garrison-snapshots-prune.timer (weekly)"
else
  echo "FOLLOWUP: wrote units to $USER_UNIT_DIR but could not enable them; run:"
  echo "    systemctl --user enable --now garrison-snapshots.timer garrison-snapshots-prune.timer"
fi
echo "snapshots setup ok"
