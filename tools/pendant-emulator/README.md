# Pendant emulator

Advertises the Omi pendant's BLE GATT profile over real Bluetooth
(CBPeripheralManager) and streams committed Opus fixture audio with the
documented 3-byte framing. This is the rehearsal instrument: a real iPhone
running the Garrison Companion connects to it before the human ever picks up
the physical pendant. Haptic writes from the phone are printed with
timestamps - that printout is the device write log of a rehearsal run.

Profile, framing, and codec: `docs/pendant-protocol.md`.

## Build

- With Xcode installed: `swift build -c release` in this directory.
- Command Line Tools only: `bash build.sh` (the CLT SwiftPM on the current
  Mac is broken; the script compiles with swiftc directly).

## The two-minute rehearsal procedure

1. On the Mac: `./.build/pendant-emulator` (add `--fixture <path>` for a
   different fixture; default is the pt hello-garrison wake phrase). macOS
   will ask for Bluetooth permission on first run. The tool prints
   "advertising as Omi" when ready.
2. On the iPhone (Companion app, same room): open Pendant, tap
   "Connect pendant". The emulator prints the subscribe and starts
   streaming; the phone's feedback strip and the printed HAPTIC lines show
   the loop closing.
3. Watch the emulator output: on a wake hit you should see haptic level 1
   (wake), then level 2 twice (window closed), then level 3 (card created),
   each with a +ms timestamp.
4. Interactive commands while running: `b` = button single-tap notify,
   `low` = battery 8 percent notify, `again` = restream the fixture,
   `q` = quit.

The emulator streams whenever a central subscribes to the audio
characteristic; the capture service must be running with
`pendant_enabled: true` (and its `enabled` master flag on) for the phone to
open a session. What the platform cannot automate here - real-radio
advertising needs a human holding a phone - is exactly this procedure;
everything below the radio is covered by the automated harness layers 1
and 2.
