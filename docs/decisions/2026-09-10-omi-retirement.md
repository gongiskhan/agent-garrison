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
| CSG | None | Rechecked after recovery: none |

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

## Live outcome and remaining checks

The cloud cleanup shipped as `02aacbb6`. Madrid, Mini and Pro each passed
15/15 live fitting health checks; CSG passed 10/10 and remains intentionally
unequipped for Capture. Native bootstrap on Madrid, Mini and Pro returned the
existing Capture credential and all five node choices, with transcription,
pendant, wake, speech and push enabled and `wake_only` preserved. Madrid and Pro
also passed the authenticated active-conversation read and returned 404 for
retired text ingest. All three replacement triage jobs completed a live tick
with exit 0. Four owner-scoped Capture jobs exist; all old Omi jobs and six
Omi authority keys are absent. Active materialized environments on the four
reachable nodes have no Omi keys, and no Omi MCP registration remains there.

Air returned before closeout and passed 15/15 live views, native bootstrap,
authenticated active-conversation read, and the retired-ingest 404 check. Its
replacement triage job also exited 0. The dirty manifest was only the ordering
of the unchanged `triage_enabled: true` key; this was normalized after proving
all other bytes equal. Its Omi MCP/environment keys and public Funnels are
absent, and its private Claude configuration is now mode 0600 too. All five
Garrison nodes have now been audited; all four Capture hosts have live acceptance.

Deployment uncovered and repaired two operational problems: platform-specific
lockfile mutation, and concurrent installation/build before the old restart
lease was acquired. Deployment now uses `npm ci` with native lifecycle builds
and the repository's PTY permission repair, acquires the mesh lease before any
installation/build, and rechecks Conversations immediately before stopping.
One-shot maintenance-script updates do not restart Capture. Eleven targeted
guard/audit tests pass, including proof that a held lease prevents either
reload or redeploy from reaching an installer/build. Native PTY loading passed
on CSG after its clean install.

All five nodes had broadly readable Claude configuration files;
they are now mode 0600. State credentials and materialized Capture environments
were already private. Madrid SSH has password and keyboard-interactive login
disabled. RustDesk also listens on all interfaces at TCP 21118; the operator's
choice of disabling it or retaining tailnet-only access is pending to avoid
cutting a legitimate remote desktop connection. See the
[RustDesk security settings](https://rustdesk.com/docs/en/self-host/client-configuration/advanced-settings/).

Madrid's Capture HTTPS mapping is currently 8498 because another project's
private file share already occupies 8497. Native bootstrap correctly discovers
8498; existing mappings were preserved. Do not replace it with an assumed port.
