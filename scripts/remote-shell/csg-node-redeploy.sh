#!/usr/bin/env bash
# csg-node-redeploy.sh <reload|redeploy>
#
# Pulls csg's node/csg branch to whatever dev-madrid has already pushed there
# (never a merge FROM csg - code moves through git, one direction only: this
# machine pushes to origin, csg fast-forwards), then restarts csg's Garrison
# node process the same way `npm run node:reload`/`node:redeploy` would on
# any other node. Run FROM dev-madrid, against csg over the tether - never on
# csg itself.
#
# Requires `Host csg` in dev-madrid's ~/.ssh/config (written by
# csg-node-install.sh, G7) and that csg is currently tethered and reachable
# (check `curl -s 127.0.0.1:8098/tether` first if this fails to connect).
set -euo pipefail

VERB="${1:-}"
case "$VERB" in
  reload|redeploy) ;;
  *) echo "usage: csg-node-redeploy.sh <reload|redeploy>" >&2; exit 2 ;;
esac

say() { printf '[csg-node-redeploy] %s\n' "$*"; }

say "reading csg's own node.json (its appOrigin - the address WE reach it at)"
NODE_JSON="$(ssh csg 'cat ~/.garrison/node.json' 2>/dev/null)" || {
  echo "csg unreachable over ssh - is the tether up? check: curl -s 127.0.0.1:8098/tether" >&2
  exit 1
}
APP_ORIGIN="$(printf '%s' "$NODE_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).appOrigin||"")}catch{process.exit(1)}})')" || {
  echo "csg's node.json is not valid JSON" >&2
  exit 1
}
[ -n "$APP_ORIGIN" ] || {
  echo "csg's node.json has no appOrigin - it may not be a tethered install (see docs/decisions/2026-09-03-shells-and-mesh-sessions.md section 2.5)" >&2
  exit 1
}

say "pulling on csg: git fetch + fast-forward-only merge to origin/node/csg"
ssh csg 'bash -lc "cd ~/dev/garrison && git fetch -q origin && git merge -q --ff-only origin/node/csg"' || {
  echo "csg's checkout did not fast-forward - it may carry local commits git refuses to discard; resolve on csg directly, never with a force push from here" >&2
  exit 1
}
REMOTE_HEAD="$(ssh csg 'bash -lc "cd ~/dev/garrison && git rev-parse --short HEAD"')"
say "csg now on $REMOTE_HEAD"

say "running on csg: npm run node:$VERB (redeploy can take a few minutes)"
ssh csg "bash -lc 'cd ~/dev/garrison && npm run node:$VERB'"

say "waiting for csg's /api/mesh/self to answer through $APP_ORIGIN"
for i in $(seq 1 30); do
  curl -sf -o /dev/null --max-time 5 "$APP_ORIGIN/api/mesh/self" && break
  sleep 3
done
HEALTH="$(curl -sf --max-time 5 "$APP_ORIGIN/api/mesh/self")" || {
  echo "FAILED: csg's /api/mesh/self never answered through $APP_ORIGIN after the restart" >&2
  exit 1
}
printf '%s' "$HEALTH" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=JSON.parse(d);console.log(`[csg-node-redeploy] /api/mesh/self OK - git ${s.git?.head ?? "?"}, degraded=${s.degraded}`)}catch{console.error("[csg-node-redeploy] /api/mesh/self did not return valid JSON");process.exit(1)}})' || exit 1
say "DONE: csg redeployed to $REMOTE_HEAD"
