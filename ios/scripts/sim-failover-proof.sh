#!/bin/zsh
# Prove the node failover on a simulator, the way the bug actually happens: the
# app is PINNED to a persisted origin that has stopped serving, and the only
# node switcher lives inside the page that will not load.
#
# It seeds the App Group defaults directly instead of using the DEBUG
# environment seed, because that is what the stranded user's device looks like:
# a node list with a live peer in it and a dead node selected.
#
# Two things this script had to learn the hard way:
#   * a CODE_SIGNING_ALLOWED=NO build (what `xcodebuild test` produces) gets NO
#     app-group container in the simulator, so NodeStore's writes go nowhere and
#     the app reads an empty store. Build the app target normally first.
#   * DerivedData holds more than one Garrison-* directory. Pass the app path
#     you just built; do not glob for it.
#
# Usage:
#   xcodebuild build -project Garrison.xcodeproj -scheme GarrisonApp \
#     -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" \
#     -derivedDataPath /tmp/gdd
#   ios/scripts/sim-failover-proof.sh /tmp/gdd/Build/Products/Debug-iphonesimulator/GarrisonApp.app \
#     "https://a-dead-origin.example:8977" "https://a-live-node.tail31efa.ts.net"
set -e
APP="${1:?path to GarrisonApp.app}"
DEAD="${2:?an origin that does not serve the shell}"
LIVE="${3:?an origin that does}"
DEV="${DEVICE:-iPhone 17 Pro}"
BUNDLE=com.gomes.garrison
GROUP=group.com.gomes.garrison

nm -a "$APP/GarrisonApp.debug.dylib" 2>/dev/null | grep -q failoverIfNeeded \
  || { echo "that build has no failover code in it"; exit 3; }

xcrun simctl boot "$DEV" 2>/dev/null || true
xcrun simctl bootstatus "$DEV" -b >/dev/null 2>&1 || true
xcrun simctl uninstall "$DEV" $BUNDLE >/dev/null 2>&1 || true
xcrun simctl install "$DEV" "$APP"
# The group container appears only once the app has run here at least once.
xcrun simctl launch "$DEV" $BUNDLE >/dev/null 2>&1 || true
sleep 5
xcrun simctl terminate "$DEV" $BUNDLE >/dev/null 2>&1 || true

C=$(xcrun simctl get_app_container "$DEV" $BUNDLE groups | awk '{print $2}' | head -1)
[ -n "$C" ] || { echo "no app-group container: build the app target normally, not with CODE_SIGNING_ALLOWED=NO"; exit 4; }
PLIST="$C/Library/Preferences/$GROUP.plist"
mkdir -p "$C/Library/Preferences"
python3 - "$PLIST" "$DEAD" "$LIVE" <<'PY'
import json, plistlib, sys
plist_path, dead, live = sys.argv[1], sys.argv[2], sys.argv[3]
nodes = [
    {"name": "live-peer", "shellOrigin": live, "captureBaseURL": live + ":8497", "token": "sim-probe-token"},
    {"name": "dead-node", "shellOrigin": dead, "captureBaseURL": dead, "token": "sim-probe-token"},
]
with open(plist_path, "wb") as fh:
    plistlib.dump({
        "node.list": json.dumps(nodes).encode(),
        "node.current": "dead-node",
        "capture.baseURL": dead,
        "capture.token": "sim-probe-token",
    }, fh)
PY

# cfprefsd inside the simulator has to read the file, not its own cache.
xcrun simctl shutdown "$DEV" >/dev/null 2>&1 || true
xcrun simctl boot "$DEV" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$DEV" -b >/dev/null 2>&1 || true

read_key() { python3 -c "import plistlib,sys;print(plistlib.load(open(sys.argv[1],'rb')).get(sys.argv[2],'(unset)'))" "$PLIST" "$1"; }
echo "BEFORE: node.current=$(read_key node.current)  capture.baseURL=$(read_key capture.baseURL)"
xcrun simctl launch "$DEV" $BUNDLE >/dev/null
sleep 20
xcrun simctl terminate "$DEV" $BUNDLE >/dev/null 2>&1 || true
sleep 3
echo "AFTER:  node.current=$(read_key node.current)  capture.baseURL=$(read_key capture.baseURL)"
[ "$(read_key node.current)" = "live-peer" ] || { echo "FAILED: still pinned to the dead node"; exit 1; }

# ...and a healthy node is never switched away from on the next launch.
xcrun simctl launch "$DEV" $BUNDLE >/dev/null
sleep 15
xcrun simctl terminate "$DEV" $BUNDLE >/dev/null 2>&1 || true
sleep 2
echo "RELAUNCH on the healthy node: node.current=$(read_key node.current)"
[ "$(read_key node.current)" = "live-peer" ] || { echo "FAILED: moved off a healthy node"; exit 1; }
echo "PASSED"
