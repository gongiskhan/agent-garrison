# Phone listening

Server, native Phase 2 and UI Phase 3 acceptance passed on 11 September 2026. UI screenshots and the mock control journey are recorded in [run 34636326744](https://github.com/gongiskhan/agent-garrison/actions/runs/34636326744). Combined Phase 4 acceptance and TestFlight delivery are pending.

## Intent and actual

`intent` is the user's request (`listening` or `off`). `actual` is a device report or watchdog decision: `off`, `starting`, `listening`, `interrupted`, `stalled`, or `failed`. Only the owning native device can change phone intent. Starting one source sets the other source's intent to `off`, with `source_switch`. Home, Capture and the header share server snapshots; browser controls are read-only. Start reuses the existing consent notice. Stop requires a 1500 ms hold and a light haptic.

A queued or unacknowledged Stop prevents foreground recovery from using stale server intent. This transient guard clears on server acknowledgement or an explicit new Start; it is not persisted.

The receiving node owns the record in CaptureStore's versioned `device_listening.json`. Migration adds version 1 without resetting existing data. This is the Phase 0 D4 correction: the existing capture store is node-local, not the mesh SQLite service.

| Fields | Meaning |
| --- | --- |
| `device_id`, `device_name`, `source`, `app_version` | Keychain UUID, native device name, `phone` or `pendant`, version string |
| `intent`, `actual`, `reason` | Requested state, reported state, closed reason code or null |
| `last_seen_at`, `intent_changed_at`, `actual_changed_at` | Server ISO8601 timestamps; last seen may be null |
| `stall_episode_id`, `stall_pushes_sent` | Episode identifier or null, delivery count for that episode |

Native messages are `listening.intent`, `listening.transition` and `listening.heartbeat`. The existing authenticated capture socket returns full `listening.state` records and `wake.detected`. The shell's existing voice relay exposes read-only SSE.

## Timing and recovery

Server constants are in `listening-config.mjs`, mirrored by native `ListeningConstants`:

```text
HEARTBEAT_SECONDS = 5
WATCHDOG_TICK_SECONDS = 5
STALL_AFTER_SECONDS = 20
STALL_PUSH_REPEAT_MINUTES = 10
STALL_PUSH_MAX_PER_EPISODE = 2
STOP_HOLD_MS = 1500
RESUME_RETRY_SCHEDULE_SECONDS = [2, 5, 15, 30, 60]
RESUME_GIVE_UP_MINUTES = 10
WAKE_ACK_MAX_LATENCY_MS = 1000
```

Heartbeats are independent of audio frames and travel on the media connection. Missing both creates a stall; fresh activity clears it with `watchdog_recovered`. Push delivery is deduplicated by episode plus ordinal, permitting one reminder. Intent `off` clears the episode and suppresses pushes. Both sources use this mechanism.

Retries repeat the final 60-second delay. Interruptions, route changes and media-service resets recover an existing user-started session. Foreground entry restores server intent and reopens a stalled upload, even if the engine remains alive. A killed process requires foreground entry, such as tapping the existing capture deep link.

Closed reasons: `user_start`, `user_stop`, `source_switch`, `interruption_began`, `interruption_ended_resumed`, `interruption_ended_no_resume`, `route_change`, `media_services_reset`, `engine_error`, `permission_denied`, `resume_retry`, `resume_gave_up`, `resume_on_foreground`, `app_terminated`, `watchdog_stalled`, `watchdog_recovered`.

## Native audio contract

AVAudioEngine sends existing 16 kHz mono Opus packets, about 20 ms each, through CaptureUploader. Both sources use the existing ingest, Deepgram and wake pipeline. D12 follows the pendant's `wake_only` retention; full ambient transcripts are not persisted. Provider keys stay server-side.

The session uses `.playAndRecord`, `.default`, and exactly `[.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker]`. Mixing preserves other audio; A2DP preserves music quality without selecting a headset microphone; speaker default avoids the earpiece. `.allowBluetooth` is excluded. Background `audio` mode remains enabled. Start activates the session, deliberate stop deactivates it, and background entry does not deactivate it. Phone wake acknowledgement is a generated 150 ms rising two-note tone through the current output route.

## Verification and device checks

`scripts/phone-listening-server-proof.mjs` verifies real WebSocket stall/recovery and dry-run push delivery. The Phone listening validation workflow runs component-backed simulator journeys and XCTest against an isolated built shell, exports screenshots and compiles the device target. Physical checks remain separate: follow [the seven-step device checklist](phone-listening-checklist.md).
