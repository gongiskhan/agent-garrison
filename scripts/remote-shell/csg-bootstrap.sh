#!/usr/bin/env bash
# CSG VM bootstrap - run INSIDE WSL Ubuntu on AZR-IMvwYA5CQHr as user ggomes.
# Idempotent. Sets up: sshd on 2222 (key-only, NAT-isolated inside WSL), tmux
# session "csg" in the work repo, and Cursor CLI hooks that append agent
# start/stop events to a LOCAL file (~/.garrison/events.jsonl). Nothing here
# opens any outbound connection; Garrison reads the events file over the same
# inbound ssh channel it uses for everything else.
set -euo pipefail

echo "== [1/5] openssh-server + tmux =="
if ! command -v sshd >/dev/null && ! [ -x /usr/sbin/sshd ]; then
  sudo apt-get update -qq && sudo apt-get install -y openssh-server
fi
command -v tmux >/dev/null || sudo apt-get install -y tmux

echo "== [2/5] sshd config: port 2222, key-only =="
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

echo "== [3/5] authorized key for Garrison =="
mkdir -p ~/.ssh && chmod 700 ~/.ssh
GARRISON_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGCY7LNMdGtN4LsUek23Crk7Cs02bNlKPxCv7fQyQUt0 garrison-remote-shell@dev-madrid'
grep -qF "$GARRISON_KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$GARRISON_KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

echo "== [4/5] Cursor CLI hooks -> ~/.garrison/events.jsonl (local file only) =="
mkdir -p ~/.garrison ~/.cursor
cat > ~/.garrison/agent-event-hook.sh <<'EOF'
#!/usr/bin/env bash
# Cursor CLI hook: append one JSON line per agent lifecycle event to a LOCAL
# file. $1 = event name (agent-start | agent-stop). No network calls of any
# kind - Garrison tails this file over its inbound ssh channel.
event="${1:-agent-stop}"
input=$(cat 2>/dev/null || true)
python3 - "$event" "$input" >> ~/.garrison/events.jsonl 2>/dev/null <<'PY' || \
  printf '{"ts":"%s","event":"%s"}\n' "$(date -u +%FT%TZ)" "$event" >> ~/.garrison/events.jsonl
import json, sys, datetime
event = sys.argv[1]
try:
    d = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].strip() else {}
except Exception:
    d = {}
print(json.dumps({
    "ts": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "event": event,
    "session_id": d.get("conversation_id") or d.get("session_id") or d.get("chat_id"),
    "status": d.get("status"),
}))
PY
exit 0
EOF
chmod +x ~/.garrison/agent-event-hook.sh

python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".cursor" / "hooks.json"
cfg = {"version": 1, "hooks": {}}
if p.exists():
    try:
        cfg = json.loads(p.read_text())
    except Exception:
        pass
cfg.setdefault("version", 1)
hooks = cfg.setdefault("hooks", {})
hook = str(pathlib.Path.home() / ".garrison" / "agent-event-hook.sh")
# stop -> agent-stop is the lifecycle signal Garrison settles turns on.
# beforeSubmitPrompt -> agent-start marks running even for prompts typed
# directly into the TUI; harmless if this Cursor build ignores the hook name.
for name, arg in (("stop", "agent-stop"), ("beforeSubmitPrompt", "agent-start")):
    lst = hooks.setdefault(name, [])
    cmd = f"{hook} {arg}"
    if not any(isinstance(h, dict) and h.get("command") == cmd for h in lst):
        lst.append({"command": cmd})
p.write_text(json.dumps(cfg, indent=2) + "\n")
print("hooks.json:")
print(p.read_text())
PY

echo "== [5/5] tmux session 'csg' in the work repo =="
tmux has-session -t csg 2>/dev/null || tmux new-session -d -s csg -c ~/dev/pnmui-monorepo -x 220 -y 50
# Shared-attach sizing: the most recently active client drives the window size,
# so vscode.dev and Garrison can attach together without shrinking each other.
tmux set-option -t csg -g window-size latest 2>/dev/null || true
# Mouse mode: binds the wheel to copy-mode so a client can scroll the pane's
# history. Without it an attached browser terminal has nothing to scroll (tmux
# holds the history) and its wheel ticks reach the agent TUI as cursor keys.
tmux set-option -t csg mouse on 2>/dev/null || true

echo "== done. summary =="
echo "sshd:  $(sudo ss -tlnp 2>/dev/null | grep ':2222' || echo 'NOT LISTENING')"
echo "tmux:  $(tmux list-sessions 2>/dev/null || echo none)"
echo "hooks: $(ls -la ~/.garrison/agent-event-hook.sh)"
echo
echo "Remaining (outside WSL): the dev tunnel needs port 2222 forwarded -"
echo "Garrison will try 'devtunnel port create' from its side; if that does not"
echo "take, forward port 2222 once in the vscode.dev Ports panel (Private)."
