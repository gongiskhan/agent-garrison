# Omi pendant BLE protocol - clean-room reference

Research notes for the Pendant Direct build. Compiled 2026-08-20 from the
MIT-licensed BasedHardware/omi sources (repo `main`, plus docs.omi.me),
read as reference only - nothing is vendored. Every claim cites the
upstream file it was read from. The Swift implementation in `ios/` is
written fresh against this document.

Firmware variants: DevKit v1 ("Friend", XIAO nRF52840), DevKit v2
(XIAO + adafruit build), Omi CV1 (consumer pendant, nRF5340,
`omi/firmware/omi`). Where behaviour differs, each variant is called out.

## 1. Identification and advertising

- Advertised names: `"Friend"` (DevKit1), `"Omi DevKit 2"` (DevKit2),
  `"Omi"` (CV1) - from `CONFIG_BT_DEVICE_NAME` in
  `omi/firmware/devkit/prj_xiao_ble_sense_devkitv1.conf`,
  `...devkitv2-adafruit.conf`, `omi/firmware/omi/omi.conf`.
- The advertising payload carries the 128-bit audio service UUID
  (`BT_DATA_UUID128_ALL`) plus the complete name
  (`omi/firmware/devkit/src/transport.c:267-275`). Identification is by
  the advertised service `19B10000-E8F2-537E-4F6C-D104768A1214`, not by
  name (the upstream app checks `_hasService` in
  `app/lib/services/devices/discovery/native_bluetooth_discoverer.dart`).
  Our scanner filters on that service UUID directly, which also keeps
  background scanning viable on iOS (a nil-filter scan does not run in
  background).

## 2. GATT profile

All custom UUIDs share the `-E8F2-537E-4F6C-D104768A1214` tail except
where noted. Sources: `omi/firmware/devkit/src/transport.c:81-147`,
`omi/firmware/omi/src/lib/core/transport.c:136-236`,
`app/lib/services/devices/models.dart`.

| Service / characteristic | UUID | Props | Notes |
|---|---|---|---|
| Audio service | `19B10000-...` | advertised | all variants |
| Audio data | `19B10001-...` | read, notify | framed packets, section 3 |
| Audio codec | `19B10002-...` | read | 1 byte, section 4 |
| Speaker audio in | `19B10003-...` | write, notify | DevKit2 build only, section 6 |
| Settings service | `19B10010-...` | - | CV1 only |
| LED dim ratio | `19B10011-...` | read, write | 1 byte 0-100 percent, CV1 only |
| Mic gain | `19B10012-...` | read, write | 1 byte, CV1 only |
| Charging status | `19B10013-...` | read, notify | uint8 1=charging, CV1 only |
| Features service | `19B10020-...` | - | CV1 only |
| Features bitmask | `19B10021-...` | read | uint32 LE, section 5 |
| Time sync service | `19B10030-...` | - | CV1 |
| Time sync write | `19B10031-...` | write | uint32 LE epoch seconds |
| Time sync read | `19B10032-...` | read | |
| Button service | `23BA7924-0000-1000-7450-346EAC492E92` | - | all variants |
| Button trigger | `23BA7925-0000-1000-7450-346EAC492E92` | notify | 8 bytes, section 7 |
| Storage service | `30295780-4301-EABD-2904-2849ADFEAE43` | - | offline sync, section 8 |
| Storage write/notify | `30295781-...` (same tail) | write, notify | commands + data |
| Storage read | `30295782-...` (same tail) | read | status |
| Haptic service | `CAB1AB95-2EA5-4F4D-BB56-874B72CFC984` | - | DevKit2 + CV1 |
| Haptic trigger | `CAB1AB96-2EA5-4F4D-BB56-874B72CFC984` | write | 1 byte, section 6 |
| Battery service | `180F` | - | standard BAS |
| Battery level | `2A19` | read, notify | 1 byte percent |
| Device information | `180A` | read | mfr `2A29` "Based Hardware", model `2A24` "Omi", HW `2A27`, FW `2A26` |

Trap: OmiGlass reuses `19B10010/11/12` for its OTA service - disambiguate
by device type, never by UUID alone (`app/lib/services/devices/models.dart`).

## 3. Audio packet framing

Firmware `push_to_gatt()` (`omi/firmware/devkit/src/transport.c:554-609`,
same logic in `omi/firmware/omi/src/lib/core/transport.c`). Every
notification on `19B10001` is:

| Bytes | Meaning |
|---|---|
| 0-1 | packet id, uint16 little-endian, +1 per notification, wraps at 65536 |
| 2 | frame index within the current codec frame; 0 = first fragment of a new frame |
| 3.. | codec payload fragment, `min(mtu - 3, remaining)` bytes |

With Opus frames of at most 80-160 bytes and any negotiated MTU >= 163,
one codec frame fits one notification and byte 2 is almost always 0.

Reassembly (canonical client logic, `storeFramePacket` in
`app/lib/utils/audio/wav_bytes.dart`; native Swift equivalent
`processPacketData` in
`desktop/macos/Desktop/Sources/Audio/BleAudioProcessor.swift`):

- `frame_index == 0` closes the pending frame and starts a new one;
  otherwise append the fragment.
- Gap rule: if `packet_id != last + 1` (mod 65536), or a non-zero
  `frame_index` is not contiguous, drop the pending partial frame, count
  a loss, reset, and wait for the next `frame_index == 0`. No silence
  insertion, no retransmission - the decoder simply sees one fewer frame.
- iOS never requests an MTU (no API); Android requests 512. Assume
  fragmentation is possible and implement reassembly anyway.

## 4. Codec characteristic

Read `19B10002` returns one byte, the compile-time codec id
(`audio_codec_read_characteristic`, `devkit/src/transport.c:303-310`):

| Id | Codec | Shipped by |
|---|---|---|
| 0 | PCM16 16 kHz mono | - |
| 1 | PCM16 8 kHz mono | app fallback when the read fails |
| 10 / 11 | mu-law 16/8 kHz | docs only, legacy |
| 20 | Opus, 160-sample (10 ms) frames, 100/s | DevKit default (`devkit/src/config.h`) |
| 21 | Opus, 320-sample (20 ms) frames, 50/s | CV1 default (`omi/src/lib/core/config.h`) |

Opus encoder parameters (`config.h` + `codec.c` both trees): 16000 Hz,
1 channel, CELT restricted-lowdelay, bitrate 32000 VBR, complexity 3,
max encoded frame `samples / 2` bytes (80 or 160).

Both Opus ids are raw Opus packets that Deepgram's `encoding=opus`
live mode accepts as-is; the existing capture-service wire (one Opus
packet per binary frame, 16 kHz mono) matches without transcoding. Our
fixtures use 20 ms frames (id 21 shape), matching the consumer pendant.

## 5. Features bitmask

CV1 only - characteristic `19B10021`, read-only uint32 little-endian
(`omi/firmware/omi/src/lib/core/features.h`, verbatim values):

```
SPEAKER = 1<<0, ACCELEROMETER = 1<<1, BUTTON = 1<<2, BATTERY = 1<<3,
USB = 1<<4, HAPTIC = 1<<5, OFFLINE_STORAGE = 1<<6, LED_DIMMING = 1<<7,
MIC_GAIN = 1<<8
```

DevKit firmwares do not expose the service at all; a failed read must be
treated as 0 and capability probed by characteristic presence (the
upstream app returns 0 on error and never gates haptics on the bit -
it writes and swallows errors). Expected CV1 value:
`HAPTIC|BUTTON|BATTERY|OFFLINE_STORAGE|LED_DIMMING|MIC_GAIN` = 0x1EC -
note bit 0 (speaker) is NOT set on the consumer pendant.

## 6. Speaker and haptic control surface

This is the load-bearing finding for device feedback. Two separate write
surfaces exist; production apps use only the haptic one.

### Haptic trigger (DevKit2 + CV1) - the usable surface

One byte written to `CAB1AB96-2EA5-4F4D-BB56-874B72CFC984` (service
`CAB1AB95-...`). Firmware runs a fixed lookup table; no duration,
intensity, or waveform parameters travel over BLE:

| Byte | DevKit2 (`devkit/src/speaker.c`, `speaker_haptic_handler`) | CV1 (`omi/src/haptic.c`, `haptic_write_handler`) |
|---|---|---|
| 0x01 | vibrate 20 ms | vibrate 100 ms |
| 0x02 | vibrate 50 ms | vibrate 300 ms |
| 0x03 | vibrate 500 ms | vibrate 500 ms |
| other | rejected | ignored (warn) |

Actuation is a bare GPIO with an off-timer (DevKit2 `gpio1.11`; CV1
devicetree `motor_pin` gpio0.25). Patterns can only be composed
app-side by spacing multiple 1-byte writes - upstream does exactly this
(`playFindDevicePattern` in
`app/lib/services/devices/connectors/device_connection.dart`: level 3
three times, 750 ms apart) and uses level 1 on voice-command start and
level 2 on first response chunk (`capture_controller.dart`). Only level
3 (500 ms) is timing-consistent across firmwares.

On DevKit2 the haptic characteristic lives inside the speaker service
and disappears when the speaker build flag is off; on CV1 it registers
under `CONFIG_OMI_ENABLE_HAPTIC` with write-only props.

### Speaker audio streaming (DevKit2 only) - not a product surface

Characteristic `19B10003` inside the audio service, compiled only under
`CONFIG_OMI_ENABLE_SPEAKER` (DevKit2). Protocol
(`devkit/src/speaker.c speak()` +
`omi/firmware/scripts/devkit/play_sound_on_friend.py`): subscribe, write
a 4-byte LE total length, then 400-byte chunks of mono 16-bit 8 kHz PCM,
paced by a notify of `uint16 400` after each chunk; playback is one-shot
after full upload via I2S, followed by a hard-coded 4 s sleep. The
accumulation buffer is 10000 bytes = roughly 312 ms of audio, with no
bounds check. No production client writes to it; there are no
BLE-addressable predefined sounds. The consumer CV1 has no speaker at
all (`CONFIG_OMI_ENABLE_SPEAKER=n`, no I2S node in its devicetree).

### Hardware matrix

| Device | Speaker | Haptic | Features char | LED dim |
|---|---|---|---|---|
| DevKit1 | no | no | no | no |
| DevKit2 (adafruit build) | yes (I2S) | yes | no | no |
| Omi CV1 (consumer) | no | yes | yes | yes |

Design consequence (recorded as ADR D4): device-side feedback is built
on haptic patterns composed from the three fixed levels, feature-gated
optimistically (read `19B10021`, fall back to try-and-swallow on write,
as upstream does). Streamed speaker audio is declared out of scope; the
stock surface is sufficient for five distinguishable tiers, so no
custom-firmware proposal is required.

## 7. Button and battery

- Button notify payload is 8 bytes - two native int32 LE, event code in
  byte 0: `1` single tap, `2` double tap, `3` long tap, `4` press,
  `5` release (`omi/firmware/{devkit/src,omi/src/lib/core}/button.c`,
  `TAP_THRESHOLD 300` ms, `DOUBLE_TAP_WINDOW 600` ms,
  `LONG_PRESS_TIME 3000` ms). Second int is always 0.
- Battery is standard BAS: read once at connect, then subscribe
  (notifications need firmware >= 1.5 per docs.omi.me). No polling.
  Upstream throttles UI/persistence updates to first reading, >= 5
  percent delta, >= 15 min elapsed, or crossing 20 percent low.

## 8. Storage service (offline sync) - reference only

Three protocol generations share service `30295780-...`, selected by
firmware version (multi-file >= 3.0.17, ring buffer >= 3.0.20, else the
devkit file protocol): commands on `30295781`, e.g. ring protocol
`0x10 INFO`, `0x11 READ [start_seq u64 BE]`, `0x12 ADVANCE`,
`0x13 CLEAR`, with tagged notifications (`0x02 INFO`, `0x03 DATA`,
`0x04 DONE`, `0x05 READ_BEGIN`) and 444-byte records
`[timestamp u32 BE][440 bytes of [len u8][opus frame]... packing]`
(`omi/firmware/omi/src/lib/core/storage.c`,
`app/lib/services/devices/ring_protocol.dart`). Consumer-commit rule:
advance the ring only after DONE and full local persistence.

Pendant Direct does not implement BLE offline sync (ADR D9): the
Companion's App Group spool already covers network drops, and BLE-side
gap recovery is a later, separate concern. Documented here so the
protocol knowledge is not lost.

## 9. Connection lifecycle patterns worth porting (from the native iOS layer)

From `app/ios/Runner/Ble/OmiBleManager.swift`,
`app/lib/services/devices/transports/native_ble_transport.dart`,
`app/lib/services/devices.dart`:

1. Connect by retrieval, not scan: `retrievePeripherals(withIdentifiers:)`
   then `connect`; a stored identifier allows background reconnection
   without any scan.
2. iOS reconnection has no backoff: on unexpected disconnect or failed
   connect, re-issue `connect()` after a fixed 200 ms - a pending
   connect waits at the chipset level for free until the peripheral
   advertises. Never chase peripherals that were never connected.
3. `CBError.peerRemovedPairingInformation` is terminal: stop
   auto-reconnect and surface pairing-lost to the user.
4. Track a manual-disconnect set so intentional disconnects are not
   fought by the auto-reconnect path; `connect()` is idempotent, so a
   foreground kick re-issues it even for peripherals stuck connecting.
5. State restoration: init the central with
   `CBCentralManagerOptionRestoreIdentifierKey`; in `willRestoreState`
   re-adopt peripherals, mark them ever-connected, and re-issue
   `connect` (or service discovery if already connected).
6. Service discovery: discover all services, then all characteristics,
   and declare ready only when every service has characteristics.
   Normalize 16-bit UUID strings ("180A") to full 128-bit form at the
   boundary.
7. Post-reconnect notifications can be silently dead: re-issue
   `setNotifyValue` for every previously active characteristic, then arm
   a 4 s audio liveness watchdog that force-rewrites the CCCD exactly
   once before giving up to a logged state.
8. `didDisconnectPeripheral` and `didFailToConnect` can both fire for
   one drop - guard state clearing. Fail pending read/write completions
   on disconnect or callers hang. Finalize any in-flight capture on
   disconnect (no further packet will trigger a gap-based finalize).
9. Audio-start sequence: time sync write (CV1), device info reads,
   battery read + subscribe, codec read, button subscribe, then audio
   subscribe. Codec is re-read on every upstream socket re-establishment.
10. Background modes upstream declares: `bluetooth-central` (plus others
    we do not need). While backgrounded they consume audio natively and
    keep the UI layer idle - our equivalent is relaying frames straight
    from the BLE callback into the existing uploader spool.

## 10. The page-facing surface: `GarrisonPendant` (2026-09-02)

Nothing in sections 1-9 reaches the web page. The pendant belongs to the app
(`PendantController.shared`, ADR D4 in `docs/decisions/2026-09-garrison-app.md`
and D44 there) and the capture page sees it only through the Capacitor plugin
`GarrisonPendant`:

- methods `status()`, `connect()`, `disconnect()`, `forget()`, each resolving
  the same payload: `connectionState` (the `PendantConnectionState` case
  names: `disconnected | scanning | connecting | connected | reconnecting |
  pairingLost | bluetoothOff`), `paired`, `lostFrames`, `ambientConsent`,
  `uploaderState` (`idle | connecting | streaming | ended | failed`, with
  `uploaderError` on failure), and when known `battery`, `sessionId`,
  `hapticSupported`, `capturePolicy`, `pendantFlagOn`;
- events `pendantState` (the payload above, debounced to one per 150 ms
  burst) and `pendantBattery` (`{battery}`).

The audio never crosses the bridge: the phone streams it to capture-service as
a `pendant` session (ADR D5) and the page reads the words back through the
shell, `GET /api/voice/sessions/<sessionId>/events`, which relays the
provider's `/sessions/<id>/events` stream (interim and final segments, then
`{"done":true}`). The mock harness for this seam is
`ios/Tests/PendantPluginMockTests.swift`: a `PendantController` on
`MockPendantTransport`, driven through the plugin exactly as the bridge drives
it.
