# Preserved feature integration — 7 September 2026

The convergence audit found five genuine feature branches outside the published
mesh histories. Their selected features were merged into the Pro's permanent
node branch and reviewed against the current repository contracts. The old
monolithic Jarvis branch was not used to restore retired Souls, memory,
composition, runtime or deployment behavior.

Decision card: `01M1YEB812YZX95EX37BM8AWPR`. Each nontrivial merge preserved a
`garrison/premerge/garrison/goncalos-macbook-pro/<timestamp>` tag. The registry
conflict retained all 77 current entries and appended Jarvis; lockfile changes
were regenerated. These optional fittings are not stationed automatically.

## Source and review

| Feature | Preserved source | Merge checkpoint | Corrective work |
| --- | --- | --- | --- |
| Spotify | `b01ccef5` | `e177a5b8` | Bounded authenticated requests, supplied environment, exact device selection, input validation and redacted failures |
| Preflight | `6c1df281` | `f950910b` | Current manifest authority, guarded repairs, Git review fingerprint, serialized mutations and verification only for stopped compositions |
| Project Viewer | `6b773dbe` | `47739030` | `00cb92b7`: confined storage and cleanup, independently preserved copies, escaped rendered evidence, real Git-backed samples, capture isolation and bounded dispatch |
| Local Voice | `0a81dc50` | `65e349f3` | `1fb99d44`: bounded requests/audio, explicit capabilities, valid complete WAV output, supervised children and external model cache |
| Jarvis | `4b5f0802` | `3d201716` | `8e3356f4`: current selected voice provider, scoped Capture token, canonical mesh sessions, bounded transport and cancellation-safe browser voice controls |

`db7d9f9f` additionally routes composition edits through the shared manifest
writer. Four new authority-path regressions and the affected 41-test suite
passed. Spotify passed 67 affected tests; Preflight passed 137. Independent
review was performed across file ownership boundaries.

## Browser and runtime evidence

Preflight's isolated Chromium check exercised a failed report followed by Retry,
a failed repair followed by retry, disabled verification for a running
composition, and the full proposed registry diff. Desktop and 390-pixel phone
viewports had no horizontal overflow or page errors. It made no live repair.
Pro evidence: `/private/tmp/garrison-preflight-ui-review-20260907.json`.

Project Viewer passed 251 focused tests and a real temporary-Git and HTTP pilot with six synthetic
flows and an isolated HTTPS Chromium walkthrough of code/explanation, logic and
state navigation. These are synthetic flows, not six authored production
narratives. The latter acceptance remains open under roadmap `c6.5`. No client
project, model or live Kanban card was used. Screenshots are retained on Pro at
`/private/tmp/garrison-project-viewer-{desktop,mobile}.png`; test logs use the
`/private/tmp/garrison-project-viewer-final-` prefix.

Local Voice generated a valid 212,012-byte WAV with RMS 0.08917 and transcribed
“This is a local voice test. The system is ready.” exactly using tiny.en.
The final transcription took 202 ms. A 901-character request returned 413;
malformed audio returned 400. Shutdown closed the public port, removed its
owned status record and terminated the Python child. Wake-word capture and
microphone input were off. PyAV also decoded a valid two-second fixture and
rejected malformed and over-120-second audio. This does not establish physical
microphone, wake-word, Portuguese or whisper.cpp accuracy. Native inference
cancellation is cooperative; the worker gate remains held until completion.
Evidence: `/private/tmp/garrison-local-voice-live-20260907/result.json` and
`speech.wav` on Pro.

Jarvis passed 41 HTTP/WebSocket/entrypoint tests and 106 other focused UI/helper tests. Its actual rebuilt browser bundle passed synthetic HTTPS checks for:

- Readiness recovery without a reload and MP3-to-WAV provider changes.
- A complete 2,520-character reply split into bounded POST TTS requests.
- Cancelling a pending microphone request and releasing the late stream.
- Suppressing late TTS and chat responses after interruption/session stop.
- Canonical remote shell working-to-idle spinner transitions.
- No unsupported wake WebSocket, no obsolete shell-overlay setting, and the
  correct configured sandbox badge.
- Desktop and 390-pixel phone layouts without overflow or page errors. The phone
  transcript provides roughly 360 pixels of reading height, separate from the
  core, with the latest message remaining visible after resizing.

Evidence: `/private/tmp/garrison-jarvis-ui-review-20260907.json` and
`/private/tmp/garrison-jarvis-review-{1440,390}-20260907.png` on Pro. Audio and
microphone browser objects were controlled fixtures; actual local inference is
covered separately above. No Spotify playback, account message or client
Cursor prompt was sent.

The dependency audit found no advisories in added or changed package versions.
Its 19 reported vulnerable package entries already existed in release
`6184f717`; this integration does not claim a clean repository-wide audit.
The audit comparison is retained at
`/private/tmp/garrison-feature-dependency-audit-20260907.json`.

## Operational acceptance

At this checkpoint, published release `6184f717` remains live on Pro,
dev-madrid, Mini and Air. Feature repair commits are not yet a deployed release.
The combined suite and final deployment acceptance must be recorded below
before claiming the feature integration live.

During validation, root invoked the wrong Jarvis entrypoint with `--probe`.
It briefly started an unstationed HTTP process (PID 94899) on Pro. Root verified
that exact command, terminated only that process, and confirmed its port closed
and status record removed. No request, account action or composition change was
performed. The intended non-mutating probe is `scripts/probe.mjs --probe`. Repair `8e3356f4` also makes `start.mjs --probe` delegate safely and rejects unknown arguments before starting a service; subprocess regressions cover this.

Csg's tunnel relay connects but its forwarded SSH/web services reset before a
usable connection. Its current checkout and release remain unverified; roadmap
`c2.12` stays open until all-node acceptance. Existing conversation and native
session evidence is in [the native-session validation](2026-09-07-native-session-visibility.md).
