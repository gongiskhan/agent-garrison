#!/usr/bin/env bash
# Garrison Mesh node installer — turns a machine into a full node.
#
#   1. On dev-madrid, issue the enrolment token:
#        cd ~/.garrison-state/current && node scripts/issue-node-token.mjs <name> --accent <palette-id> --platform darwin
#   2. On the machine:
#        bash scripts/install-node.sh --name <name> --accent <palette-id> \
#          --token <token> --state-url https://dev-madrid.tail31efa.ts.net:8860
#
# Exit criterion (the ONLY thing that counts as installed): /api/mesh/self
# answers 200 locally AND this node is visible on another node's /mesh within
# 45 seconds. Nothing less.
#
# Rules carried from the retired remote-Mac workflow:
#   * SYMLINK REFUSAL — an adopted checkout may not be reached through a
#     symlink; a dangling link must never become a live link into a tree.
#   * NEVER sync into a live checkout — code moves only through git.
set -euo pipefail

NAME="" ACCENT="" TOKEN="" STATE_URL="" REPO_DIR="$HOME/dev/garrison"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --accent) ACCENT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --state-url) STATE_URL="$2"; shift 2 ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$NAME" ] && [ -n "$TOKEN" ] && [ -n "$STATE_URL" ] || {
  echo "usage: install-node.sh --name <node> --token <mesh-token> --state-url <https://...> [--accent <palette-id>] [--repo-dir <dir>]" >&2
  exit 2
}

say() { printf '[install-node] %s\n' "$*"; }

# ── 1. preflight ────────────────────────────────────────────────────────────
for cmd in git node npm tailscale curl; do
  command -v "$cmd" >/dev/null || { echo "preflight: $cmd not found" >&2; exit 1; }
done
TAILNET_HOST="$(tailscale status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{process.exit(1)}})')" || {
  echo "preflight: tailscale is not up (no Self.DNSName)" >&2; exit 1
}
say "tailnet host: $TAILNET_HOST"
curl -sf --max-time 10 "$STATE_URL/v1/health" >/dev/null || {
  echo "preflight: state service unreachable at $STATE_URL — is it published to the tailnet?" >&2; exit 1
}

# ── 2. checkout: clone fresh or adopt, symlink-refused ──────────────────────
if [ -L "$REPO_DIR" ]; then
  echo "refusing: $REPO_DIR is a symlink — an adopted checkout must be a real directory" >&2
  exit 1
fi
if [ -d "$REPO_DIR/.git" ]; then
  say "adopting existing checkout at $REPO_DIR"
else
  say "cloning agent-garrison into $REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone -q git@github.com:gongiskhan/agent-garrison.git "$REPO_DIR" \
    || git clone -q https://github.com/gongiskhan/agent-garrison.git "$REPO_DIR"
fi
cd "$REPO_DIR"
git fetch -q origin
# The node branch is created ONCE, here — never by an agent (the no-new-
# branches hard rule stands; this is the sanctioned exception, by plan).
if git show-ref -q "refs/remotes/origin/node/$NAME"; then
  git checkout -q "node/$NAME" 2>/dev/null || git checkout -q -t "origin/node/$NAME"
  git merge -q --ff-only "origin/node/$NAME" 2>/dev/null || true
else
  git checkout -q -b "node/$NAME" origin/main
  git push -q -u origin "node/$NAME"
fi
say "on branch node/$NAME @ $(git rev-parse --short HEAD)"

# ── 3. identity + enrolment files ───────────────────────────────────────────
mkdir -p "$HOME/.garrison"
node - "$NAME" "$ACCENT" "$TAILNET_HOST" <<'EOF'
const [name, accent, host] = process.argv.slice(1);
const fs = require("node:fs");
const p = `${process.env.HOME}/.garrison/node.json`;
if (!fs.existsSync(p)) {
  // accent is a PALETTE ID or index — never raw hex; the closed palette in
  // src/lib/node-identity.ts refuses unknown hex by design.
  fs.writeFileSync(p, JSON.stringify({
    id: name, name, accent: accent || undefined, tailnetHost: host,
    createdAt: new Date().toISOString()
  }, null, 2));
  console.log(`[install-node] wrote ${p}`);
} else {
  console.log(`[install-node] ${p} exists — kept (identity is permanent)`);
}
EOF
node - "$STATE_URL" "$TOKEN" "$NAME" <<'EOF'
const [url, token, node] = process.argv.slice(1);
const fs = require("node:fs");
const p = `${process.env.HOME}/.garrison/state.json`;
fs.writeFileSync(p, JSON.stringify({ url, token, node }, null, 2), { mode: 0o600 });
fs.chmodSync(p, 0o600);
console.log(`[install-node] wrote ${p} (0600)`);
EOF

# ── 4. install + branding ───────────────────────────────────────────────────
say "npm install (this takes a while on first run)"
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
node scripts/node-branding.mjs || say "branding skipped (non-fatal): $?"

# ── 5. Quarters adoption via the EXISTING install gate ──────────────────────
# Non-destructive by contract: per-item, keep-yours-on-ambiguity. The gate
# runs inside the app on first boot (/api/install + InstallBanner); nothing to
# force here — first `up` walks it.

# ── 6. session memory hooks (vault-git-sync pull on start, push on end) ─────
node - <<'EOF'
const fs = require("node:fs");
const p = `${process.env.HOME}/.claude/settings.json`;
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s.hooks = s.hooks || {};
const syncCmd = (mode) =>
  `bash "$HOME/dev/garrison/fittings/seed/vault-git-sync/scripts/sync.sh" ${mode} >/dev/null 2>&1 || true`;
const ensure = (event, mode) => {
  s.hooks[event] = s.hooks[event] || [];
  const tag = `garrison-mesh-vault-sync-${event}`;
  const flat = JSON.stringify(s.hooks[event]);
  if (flat.includes(tag)) return false;
  s.hooks[event].push({
    matcher: "*",
    hooks: [{ type: "command", command: syncCmd(mode), timeout: 120 }],
    _garrison: tag
  });
  return true;
};
const a = ensure("SessionStart", "--pull");
const b = ensure("SessionEnd", "--push");
if (a || b) {
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  console.log("[install-node] vault-git-sync session hooks installed");
} else {
  console.log("[install-node] vault-git-sync session hooks already present");
}
EOF

# ── 7. project env materialisation (anything checked out runs immediately) ──
node - "$STATE_URL" "$TOKEN" "$NAME" <<'EOF'
const [url, token] = process.argv.slice(1);
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const res = await fetch(`${url}/v1/config?prefix=loadout.`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) { console.log("[install-node] no loadout listing (skipping project env)"); return; }
  const { docs } = await res.json();
  const devRoot = fs.realpathSync(`${process.env.HOME}/dev`);
  for (const doc of docs ?? []) {
    const project = doc.namespace.replace(/^loadout\./, "");
    const projectDir = path.join(devRoot, project);
    if (!fs.existsSync(path.join(projectDir, ".git"))) continue;
    const envRes = await fetch(`${url}/v1/secrets/loadout-env`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ project })
    });
    if (!envRes.ok) {
      console.log(`[install-node] ${project}: env render refused (${envRes.status}) — grants are a deliberate act on dev-madrid`);
      continue;
    }
    const { content, missing } = await envRes.json();
    fs.writeFileSync(path.join(projectDir, ".env"), content, { mode: 0o600 });
    console.log(`[install-node] ${project}: .env rendered${missing?.length ? ` (missing: ${missing.join(",")})` : ""}`);
  }
})().catch((e) => console.log(`[install-node] project env pass skipped: ${e.message}`));
EOF

# ── 8. always-on service unit ───────────────────────────────────────────────
NODE_BIN="$(command -v node)"
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/io.garrison.node.plist"
  # launchd has no node on PATH: ProgramArguments[0] must be absolute, PATH
  # explicit — the exact trap the outpost bridge hit.
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.garrison.node</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$REPO_DIR/scripts/garrison-instance.sh</string>
    <string>node</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.garrison/node-launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.garrison/node-launchd.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/io.garrison.node" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  say "launchd unit io.garrison.node loaded"
else
  UNIT="$HOME/.config/systemd/user/garrison-node.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<SD
[Unit]
Description=Garrison mesh node
After=network-online.target tailscaled.service

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/env bash $REPO_DIR/scripts/garrison-instance.sh node start
Restart=always
RestartSec=5
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
SD
  systemctl --user daemon-reload
  systemctl --user enable --now garrison-node.service
  say "systemd unit garrison-node loaded"
fi

# ── 9. build + wait for the app ─────────────────────────────────────────────
say "building (first boot serves the built artifact)"
bash scripts/garrison-instance.sh node build >/dev/null 2>&1 || say "build reported non-zero — the unit will retry"
if [ "$(uname)" = "Darwin" ]; then
  launchctl kickstart -k "gui/$(id -u)/io.garrison.node" 2>/dev/null || true
else
  systemctl --user restart garrison-node.service
fi
APP_PORT=8777
for i in $(seq 1 60); do
  curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$APP_PORT/api/mesh/self" && break
  sleep 3
done
curl -sf -o /dev/null "http://127.0.0.1:$APP_PORT/api/mesh/self" || {
  echo "FAILED: /api/mesh/self never answered on :$APP_PORT — check $HOME/.garrison/node-launchd.log" >&2
  exit 1
}
say "/api/mesh/self is healthy"

# ── 10. tailnet publish ─────────────────────────────────────────────────────
tailscale serve --bg --https=443 "http://127.0.0.1:$APP_PORT" >/dev/null 2>&1 \
  || say "root serve mapping failed — run: sudo tailscale set --operator=\$USER, then re-run this step"
node scripts/tailnet-serve-views.mjs || say "view publish incomplete (operator flag?) — re-run after fixing"

# ── 11. exit criterion ──────────────────────────────────────────────────────
say "waiting for this node to appear in the mesh registry (45s window)…"
DEADLINE=$(( $(date +%s) + 45 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  SEEN="$(curl -sf --max-time 5 -H "Authorization: Bearer $TOKEN" "$STATE_URL/v1/nodes" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const n=JSON.parse(d).nodes.find(n=>n.name===process.argv[1]);console.log(n?.lastSeenAt??"")})' "$NAME")" || SEEN=""
  [ -n "$SEEN" ] && break
  sleep 5
done
if [ -n "${SEEN:-}" ]; then
  say "INSTALLED: $NAME is on the mesh (last seen $SEEN). Open https://$TAILNET_HOST/"
else
  echo "FAILED the exit criterion: $NAME never reported to the registry — the heartbeat (scheduler daemon) may not be enrolled; check the unit log" >&2
  exit 1
fi
