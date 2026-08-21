#!/usr/bin/env bash
# CSG VM bootstrap - run INSIDE WSL Ubuntu on AZR-IMvwYA5CQHr as user ggomes.
# Idempotent. Sets up: loopback sshd on 2222, tmux session "csg" in the work
# repo, and a Cursor CLI stop hook that appends to ~/.garrison/events.jsonl.
# It never opens any outbound connection; the events file is read by Garrison
# over the same inbound ssh channel.
set -euo pipefail

echo "== [1/5] openssh-server + tmux =="
if ! command -v sshd >/dev/null && ! [ -x /usr/sbin/sshd ]; then
  sudo apt-get update -qq && sudo apt-get install -y openssh-server
fi
command -v tmux >/dev/null || sudo apt-get install -y tmux

echo "== [2/5] sshd config: port 2222, key-only, no public exposure =="
sudo tee /etc/ssh/sshd_config.d/garrison.conf >/dev/null <<'EOF'
# Garrison remote-shell access via the dev tunnel. WSL sits behind the
# Windows host NAT; nothing here is reachable from the physical network.
Port 2222
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ggomes
EOF
sudo mkdir -p /run/sshd
sudo service ssh restart || sudo service ssh start
sudo service ssh status | head -2 || true

echo "== [3/5] authorized key for Garrison =="
mkdir -p ~/.ssh && chmod 700 ~/.ssh
GARRISON_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGCY7LNMdGtN4LsUek23Crk7Cs02bNlKPxCv7fQyQUt0 garrison-remote-shell@dev-madrid'
grep -qF "$GARRISON_KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$GARRISON_KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

echo "== [4/5] Cursor CLI stop hook -> ~/.garrison/events.jsonl (local file only) =="
mkdir -p ~/.garrison ~/.cursor
cat > ~/.garrison/stop-hook.sh <<'EOF'
#!/usr/bin/env bash
# Cursor CLI stop hook: append one JSON line per agent stop to a LOCAL file.
# No network calls of any kind. Garrison tails this file over ssh.
input=$(cat)
python3 - "$input" <<'PY' >> ~/.garrison/events.jsonl 2>/dev/null || \
  printf '{"ts":"%s","event":"agent-stop"}\n' "$(date -u +%FT%TZ)" >> ~/.garrison/events.jsonl
import json, sys, datetime
try:
    d = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].strip() else {}
except Exception:
    d = {}
print(json.dumps({
    "ts": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "event": "agent-stop",
    "session_id": d.get("conversation_id") or d.get("session_id") or d.get("chat_id"),
    "status": d.get("status"),
}))
PY
exit 0
EOF
chmod +x ~/.garrison/stop-hook.sh

python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path.home() / ".cursor" / "hooks.json"
cfg = {"version": 1, "hooks": {}}
if p.exists():
    try:
        cfg = json.loads(p.read_text())
    except Exception:
        pass
cfg.setdefault("version", 1)
hooks = cfg.setdefault("hooks", {})
entry = {"command": str(pathlib.Path.home() / ".garrison" / "stop-hook.sh")}
lst = hooks.setdefault("stop", [])
if not any(h.get("command") == entry["command"] for h in lst if isinstance(h, dict)):
    lst.append(entry)
p.write_text(json.dumps(cfg, indent=2) + "\n")
print("hooks.json:", p.read_text())
PY

echo "== [5/5] tmux session 'csg' in the work repo =="
tmux has-session -t csg 2>/dev/null || tmux new-session -d -s csg -c ~/dev/pnmui-monorepo -x 220 -y 50
# Shared-attach sizing: last active client drives the size; keep windows usable
# when a second (smaller) client attaches.
tmux set-option -t csg -g window-size latest 2>/dev/null || true
tmux set-option -t csg -g aggressive-resize on 2>/dev/null || true

echo "== done. summary =="
echo "sshd: $(sudo ss -tlnp 2>/dev/null | grep ':2222' || echo 'NOT LISTENING')"
echo "tmux: $(tmux list-sessions 2>/dev/null || echo none)"
echo "hook: $(ls -la ~/.garrison/stop-hook.sh)"
echo "NEXT (Windows side, if 'code tunnel' runs on Windows): the tunnel needs port 2222 forwarded."
