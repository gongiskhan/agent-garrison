# Pendant connection recovery — 9 September 2026

The user supplied an iPhone screenshot from Garrison 1.0 (35): Bluetooth
Connected, remembered pairing, battery 70%, capture connecting. The Pro's
capture-service was healthy through its HTTPS tailnet URL during diagnosis,
with no current sessions. Counters since the 09:29 process start included
5,121 resumes and 901,658 duplicate audio frames. The earlier operations
handoff records capture-service becoming CPU-bound during the morning rollout.
These counters support connection churn; they do not identify the exact
network interruption that started it or prove the phone's current state.

## Findings and change

CaptureUploader did not bind callbacks to their originating socket. Send,
receive and close failures could each schedule a retry; old sockets could
clear newer tasks. The service supersedes competing sockets for the same
session, allowing a reconnect loop. The defect predates this week's changes:
the uploader last changed September 2 (conversation id), with its connection
logic inherited from August. Recent restarts or network drops can expose it.

The native uploader now has one current task, one cancellable retry, a
10-second connection/session-start deadline, and identity checks on every
callback. Retired sockets are cancelled; terminal paths cancel retry timers
and invalidate URLSession. Confirmed sessions retain the existing spool and
high-water replay protocol. End while offline settles locally.

Separately, the app-lifetime PendantController kept the old capture endpoint
and token when the shell switched nodes. Reconnect now reconciles both without
cycling Bluetooth; node/token edits trigger it even without a bridge remount.
Old uploader callbacks cannot overwrite the replacement's UI or feedback.
Manual Disconnect continues to disable automatic reconnection.

## Verification

- Shared Swift source compiled on the Pro with its installed Swift compiler.
- Nine uploader cases passed against real URLSession WebSockets and a local
  Network.framework server: normal media/acks, resume, speech receipt,
  repeated Connect, stale callbacks, drop during 300 sends, stalled handshake,
  abandon during retry and end while connecting.
- The same repeated-Connect and stale-callback assertions failed against the
  committed old uploader: 40 and 21 session starts respectively, expected 1.
- These local checks used a small standalone assertion adapter because the Pro
  has Command Line Tools, no XCTest framework, and a broken SwiftPM llbuild
  binary. The shipping sources were unmodified; the test adapter stayed in
  /tmp/garrison-pendant-tests. This is not an iOS XCTest result.
- Added iOS controller cases cover switching between two capture servers,
  changing a token on the same server, and preserving manual pause after a
  node switch. The full iOS suite is the TestFlight lane's pre-upload gate.
- No server restart, configuration write, Mini recovery, or node deployment
  was performed. This change ships as an iOS binary.

## Release and phone acceptance

Build **37** uploaded to TestFlight on 2026-09-09 at15:38 UTC from source
commit `30c3ceda19c1aaff2963f706c8c8bba77e4e56d7`.
[Native CI run](https://github.com/gongiskhan/ios-thing/actions/runs/34370001185)
passed **120 XCTest with zero failures**, then signed, archived and uploaded
the binary to App Store Connect. Sanitized result excerpts are in
`native-release.txt`. Apple processing/installation has not been observed.
The preceding run36 stopped at checkout because the abbreviated source SHA
was interpreted as a branch; run37 pins the full SHA.

After installation, verify on the
physical iPhone: launch with the remembered pendant; Bluetooth becomes
Connected and Capture becomes streaming; background/foreground; interrupt
and restore the network; switch nodes; manually Disconnect and relaunch,
then Connect to resume. A spoken harmless request must reach the selected
node and receive feedback. Physical-device acceptance remains open.
