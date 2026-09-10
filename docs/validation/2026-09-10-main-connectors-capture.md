# Main, connectors and native Capture — 10 September 2026

The operator's main-only policy supersedes permanent node branches. Initial
integration fast-forwarded main from 58708f8c through abf2d106 before feature
work. Pro, Madrid, Air, Mini and CSG now use the existing main branch. Existing
voice echo changes were preserved and committed separately after their 14
focused tests passed.

## Verification

- Google sign-in on Madrid opened Google's account chooser directly. Existing
  OAuth app credentials were found in the shared secret authority; the old
  local-vault reads had falsely reported them missing. Account sign-in and
  consent remain the user's step.
- Both live Cortex cards retained https://app.ekoa.io after saving with the
  existing key field blank. The public integration-list API at that host
  currently returns HTTP 404 with HTML. The configured URL and shared key are
  present; this is not proof that the upstream Cortex service is usable.
- Capture is absent from the connector setup list. Native bootstrap on Madrid
  and Pro returned all five mesh nodes and internally provisioned credentials;
  authenticated read-only Capture requests returned HTTP 200. Secret values
  were never included in the evidence.
- Connector authority tests used a real temporary state service and covered
  shared refresh/revoke, scoped writes and concurrent capture provisioning.
  Connector/OAuth/bootstrap/view checks passed (25 tests), with the broader
  connector, voice, composition and proxy suites also passing.
- Deployment guard tests passed (7), installation/isolation checks passed
  (34 including those guards), and the Linux supervisor suite passed (15).
  Live Air, Mini and Madrid deployments refused a restart while Pro held the
  mesh lease. Air subsequently completed its guarded restart.
- Mini XCTest passed all 122 tests, including native mesh discovery, offline
  peers, current-node preservation, URL validation and the updated bridge
  contract. GitHub's beta workflow passed and uploaded TestFlight build 39
  from 47ea2817. Physical-phone discovery, microphone and foreground failover
  remain device acceptance checks.

## Runtime synchronization

The installed main-sync job fetches and fast-forwards clean idle main checkouts.
It preserves dirty/unpublished work and defers working Conversations. App
restarts require another healthy node and an exclusive state-service CAS lease.
Independent synchronization commands and documentation do not require an app
restart. Receipts record a deployment only after a running composition and all
views are healthy. On macOS this uses launchd, on Madrid a systemd timer, and
on tethered CSG an independent flock-protected worker recovered by the existing
node supervisor. No Codex automation or new application scheduler was added.

## Owner evidence

Pro: /tmp/garrison-auth-final-tests.log, /tmp/garrison-authority-tests.log,
/tmp/garrison-sync-install-tests.log, /tmp/garrison-preserved-voice-tests.log,
/tmp/garrison-main-connectors-deploy.log. Mini:
/tmp/garrison-mesh-native-tests-final.log and the corresponding xcresult under
/tmp/garrison-mesh-native-dd/Logs/Test. Madrid:
/tmp/garrison-tether-sync-tests.log and the garrison-main-sync.service journal.
Each node keeps its receipt at ~/.garrison/main-sync.json.

TestFlight: https://github.com/gongiskhan/ios-thing/actions/runs/34441241058.
