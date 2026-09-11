# Phone listening

Phase 0 exploration completed on 11 September 2026. Phase 1 server implementation is verified; native and UI phases remain pending.

Listening separates user `intent` (`listening` or `off`) from `actual` (`off`, `starting`, `listening`, `interrupted`, `stalled`, `failed`). Only an authenticated native device channel can change phone intent. A source switch turns the other source off. Home and Capture share controls; the mobile header shows an indicator.

## Decisions

D1: Extend GarrisonCapturePlugin and CaptureController's native AVAudioEngine tap. OpusEncoder already supplies 16 kHz mono Opus, about 20 ms per packet, through CaptureUploader and the existing 17-byte binary framing on `/capture/stream`.

D2: Use AVAudioSession `.playAndRecord`, mode `.default`, options exactly `[.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker]`. Mixing preserves other apps' audio volume; A2DP preserves Bluetooth music output without enabling headset microphone input; speaker default avoids the earpiece. The existing background `audio` mode remains. Activate on start and deactivate on deliberate stop. Native speech must preserve this contract while capture is active.

D3: Intent changes only on user actions, actual on native reports or watchdog decisions.

D4 (revised): CaptureStore is an atomic file store on the receiving node, not the mesh SQLite service. Extend it with versioned `device_listening` records and a migration. Use its existing WebSocket and SSE channel patterns. Native and web clients hold server snapshots, not independent durable intent.

D5 (clarified): Watchdog deliveries are deduplicated by stall episode plus ordinal. A retry cannot duplicate a notification; ordinal two permits the requested reminder. Stop or fresh activity clears the episode.

D6 (clarified): Native interruption, route and media reset handlers recover a user-started session in the background. A new session following process death may start only in the foreground after restoring server intent. Retries use the schedule below, then report `resume_gave_up`.

D7: Bind phone control messages to the native device identity on its authenticated channel; other UIs are read-only.

D8: One active source per device, switching without a dialog.

D9: Shared ListeningControl on mobile Home and Capture, 1500 ms hold to stop, and indicator-only ListeningBadge in AppBar.

D10: Existing CompanionNotifier/APNs sender and PushRouter; `garrison://open?path=%2Fcapture%3Fsource%3Dphone` and equivalent pendant route, no actions.

D11 (revised): Existing pendant feedback has haptics and spoken cues, but no requested phone tone. Emit `wake.detected` from existing lifecycle feedback and play one generated 150 ms rising two-note tone on the phone source.

D12 (revised): Follow pendant retention policy. Current `wake_only` does not persist full ambient media or transcript; the new always-on phone mode must match it. Keep the existing transcription lane and WakeBus implementation, aggregation and card logic.

D13: Reuse ConsentSheet and AppGroup.consentSuppressed on manual start.

## Record and timing

One record per `(device_id, source)` contains `device_name`, `intent`, `actual`, `reason`, `last_seen_at`, `intent_changed_at`, `actual_changed_at`, `stall_episode_id`, `stall_pushes_sent`, and `app_version`. Device identity is a stable Keychain UUID. Timestamps are ISO8601. Sources are `phone` and `pendant`.

`HEARTBEAT_SECONDS=5`, `WATCHDOG_TICK_SECONDS=5`, `STALL_AFTER_SECONDS=20`, `STALL_PUSH_REPEAT_MINUTES=10`, `STALL_PUSH_MAX_PER_EPISODE=2`, `STOP_HOLD_MS=1500`, `RESUME_RETRY_SCHEDULE_SECONDS=[2,5,15,30,60]` (last repeats), `RESUME_GIVE_UP_MINUTES=10`, `WAKE_ACK_MAX_LATENCY_MS=1000`.

Closed reason set: `user_start`, `user_stop`, `source_switch`, `interruption_began`, `interruption_ended_resumed`, `interruption_ended_no_resume`, `route_change`, `media_services_reset`, `engine_error`, `permission_denied`, `resume_retry`, `resume_gave_up`, `resume_on_foreground`, `app_terminated`, `watchdog_stalled`, `watchdog_recovered`.

## Verification

Vitest and existing Capture harnesses cover server behavior. GarrisonTests and command-line simulator journeys cover native behavior. This Mac has Command Line Tools only; the Mini has Xcode and the existing ios-thing workflow provides TestFlight automation. No device acceptance is inferred from simulator results. The device checklist will be added in Phase 5.

Audio option references: [Apple A2DP](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetootha2dp) and [Apple mixing](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/mixwithothers).

Phase 1: 10 watchdog tests and 35 existing ingress/source-arbitration tests passed. `node scripts/phone-listening-server-proof.mjs` ran the real mock source with a stall at 10 seconds and recovery at 40 seconds. It verified a stall within 25 seconds of the last activity, exactly one dry-run push with the required copy, and `watchdog_recovered` with a cleared episode. Evidence: `evidence/phone-listening/phase1-events.log`.

## Automated validation

`node scripts/phone-listening-server-proof.mjs` runs the real ingress with provider calls disabled, cuts activity after ten seconds, and resumes at forty seconds. It records exactly one dry-run push and a cleared recovery episode in the owner's evidence directory. Intent updates do not claim an actual engine transition; the device reports that separately.

`tests/listening-control.test.ts` and `tests/listening-control-browser.test.ts` cover every label and badge state, permission copy, optimistic start, a cancelled hold and a completed hold. A completed hold consumes its release event so the newly displayed Start button cannot restart capture accidentally. The browser capture route exposes the same records read-only through the authenticated voice relay.

The Phone listening validation workflow builds the native app, runs XCTest and the simulator against an isolated Capture node, and compiles the physical device target. Passing native acceptance, simulator screenshots, the combined journey and TestFlight delivery are separate gates. Device checks are in [the checklist](phone-listening-checklist.md).

The composition projects Capture's `operative_name` setting into notification titles, with Zeca as the current default. Before the first server snapshot the phone row shows a disabled connection placeholder, without inventing an actual microphone state.
