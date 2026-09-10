# Omi cloud retirement; native pendant retained

The operator uses the Omi pendant through the Garrison iOS app and explicitly
retires the Omi apps, cloud subscription integration and account connections.
This supersedes earlier plans to retain or restore the Omi cloud channel.

## What the daily pendant actually uses

`PendantBLETransport` subscribes to the hardware over CoreBluetooth.
`PendantController` sends the reassembled Opus frames through `CaptureUploader`
to the selected Garrison node. Capture streams transcription to Deepgram,
handles Zeca wake commands and sends speech and haptic feedback to native Swift.
The phone holds the Garrison Capture token and node URL. This path makes no
Omi server call and does not consume an Omi subscription's transcription minutes.
The native iOS implementation, Bluetooth protocol, pairing/reconnection,
feedback, capture policy and voice credentials are unchanged by this cleanup.

## Removal and the important hidden dependency

The retired `omi-channel` supplied more than cloud webhooks: its scheduled
triage also drained the Garrison phone/pendant capture inbox. That retained
engine now belongs to `capture-service`, with independent owner-node
`capture-triage-<node>` jobs. It retains batching, provenance, memories, cards,
deduplication and native notification delivery. Old Capture records stay on
their owner and remain readable. Wake classification and background-triage
model selection remain separate.

Removed: the cloud fitting and registry/selection entries, webhook/Funnel
maintenance, Omi API clients, backfeed, cloud notification transport, text ingest,
cloud-only spikes/tests, Omi MCP registration and six OMI_* authority keys.
`POST /capture/ingest/text` returns 404. The audio socket and active-conversation
API remain. Legacy card origins and secret-redaction patterns are compatibility
and data protection, not an active connection. Historical records are retained.
Deleting local credentials does not claim deletion of the upstream Omi account.

`node scripts/retire-omi.mjs` previews shared-manifest changes. `--apply` uses
revision-checked writes and preserves native settings. `--apply --finalize`
removes the retired scheduler entries and OMI_* secrets; run immediately before
rolling out Capture so old and new triage jobs cannot process one inbox together.

## Public exposure audit

Observed and closed on 2026-09-10:

| Owner | Public entry | Action |
|---|---|---|
| Madrid | HTTPS 8443 `/omi` to the Omi fitting | Removed |
| Mac mini | HTTPS 8443 capture/heartbeat/MCP paths to old port 7600 | Converted to private Serve; backend absent |
| Mac mini | HTTPS 10000 Slack webhook to port 9512 | Converted to private Serve; backend absent |
| MacBook Pro | HTTPS 8443 old CSG tether to port 57330 | Converted to private Serve; backend absent |
| MacBook Air | None | Verified |
| CSG | None at initial inspection | Verify again when its tether is available |

All four primary nodes were rechecked after Madrid's reboot: no enabled public
Funnels remained. Existing private shell/Capture routes were preserved. The
other stale routes were made private without resetting the whole Serve config.
`node scripts/audit-funnels.mjs` is a read-only check: exit 0 for no Funnel,
1 for public entries, 2 when the audit cannot be completed. It checks background
and foreground configurations. Unknown/offline devices are not certified by
one reachable node's status.

## Verification and acceptance

The focused affected run passed 459 tests across 35 files, including real-cadence
pendant audio replay, wake-to-card, reconnect/resume, duplicate suppression,
ambient capture, speech/haptic fallback and phone capture. Migration and scheduler
tests additionally check exact config preservation, independent node jobs,
secret-free commands and idempotence. Capture fitting validation and TypeScript
checks passed. Wider repository checks and live rollout evidence belong to
Madrid at `evidence/omi-retirement-20260910/`.

No native build or TestFlight replacement is required: `ios/` has no changes.
A real pendant command on the current phone remains the physical acceptance
check; automated replay does not claim to have exercised the user's pendant.

The wider run completed with 8,328 passing tests, 29 skipped, 16 failing tests
and one SQLite-dependent suite setup failure. The two cleanup-related stale
expectations (CSG overlay and removed Omi delivery badge) pass after correction.
Four unrelated assertions reproduced on untouched `aa9572cb` (Cortex defaults,
instance memory roots and sidebar routes). The remaining failures require
missing `sqlite3` or the WebKit Playwright executable. This is not a claim that
the entire repository suite is green. Follow-up targeted runs passed 72 and 29
tests respectively; no failing pendant/Capture test remains.

Mini and Air also had dormant `com.omi.computer-macos` desktop apps. Both were
moved to Trash reversibly; no running Omi process or Omi login entry was found.
Garrison fitting listeners checked on the three Macs were loopback-bound.
Madrid's shell, state and scheduler were loopback-bound at inspection; SSH is
still a host service, and this task does not certify the provider's perimeter
firewall or change SSH access. Private Omi Serve mappings were removed from all
four primary nodes after stopping the retired fitting.
