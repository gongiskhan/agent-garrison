# iOS companion — build progress

Milestones per [`docs/COMPANION_IOS_SPEC.md`](../../../docs/COMPANION_IOS_SPEC.md)
(M0–M9, plus M5b). A milestone is done only with green tests and an entry here.
Design decisions in [`docs/adr-companion.md`](../../../docs/adr-companion.md);
deviations in [`DECISIONS.md`](./DECISIONS.md).

## M0 — Preflight, recon, ADR, scaffolds (2026-08-13)

Shipped:
- Preflight green: macOS 26.3.1 + Xcode 26.2 + iOS 26.2 simulators; repo
  writable; the "iOS thing" reference located as `gongiskhan/ios-thing`
  (IOS_THING_PATH was unset — cloned to `~/Projects/ios-thing`); vault
  verified on the prod host (unlocked; DEEPGRAM_API_KEY, CAPTURE_TOKEN and
  APNS_* pending as the spec predicted, reported not blocking);
  APP_BUNDLE_ID decided: `com.gomes.garrison` (user pick).
- `make remote-doctor` restored to green (origin-URL comparison normalized in
  `scripts/remote-dev.sh`; dev-madrid host key verified and added), so fitting
  tests run on dev-madrid per the house rule — the Mac runs only Xcode work.
- Recon of both reference codebases completed and recorded:
  the omi/triage/ack/echo-guard/notify seams (four-part report) and ios-thing's
  broadcast/uploader/APNs/TestFlight internals (three-part report). Three spec
  assumptions refuted (see DECISIONS): no fMP4 encoder exists, no
  ios-certificates match usage in ios-thing, no shared framework target.
- Mid-run rename absorbed: the operative is **Zeca** (commit `b3a82ec3`), wake
  gate now requires address position; all companion fixtures and defaults use
  the Zeca variants.
- `docs/adr-companion.md`: ten decisions locked (XcodeGen; one-engine triage
  with a second inbox root; APNs sender inside this fitting; byte-identical
  wake/echo-guard copies with a lockstep test; media layout; AEC-in-audio-mode
  speech policy; fitting shape; TestFlight lane with match storage on the
  private `ios-certificates` repo).
- Fitting scaffold: `apm.yml` (faculty channels, own_port 7097, provides
  channel/companion, five vault keys in secret_scope, every pipe a default-off
  flag), `lib/config.mjs` (env-only config, resolved-cfg house rule),
  `lib/store.mjs` (ulid/atomic-write/Counters + CaptureStore roots),
  `scripts/start.mjs` + `scripts/server.mjs` (live-pid status-file guard,
  /health, status page, 501 milestone surfaces, 404 non-sink /ack + /notify),
  `scripts/capture.mjs --probe` verify hook, non-blocking `scripts/setup.sh`.
- Registered in `data/library.json`; stationed in the default composition's
  channels selection with every flag off.
- `ios/` skeleton: XcodeGen `project.yml` (GarrisonApp + BroadcastExtension +
  Shared sources, manual-signing settings carried from ios-thing), minimal
  SwiftUI app, broadcast SampleHandler stub, App Group `group.com.gomes.garrison`;
  `xcodegen generate` + simulator build green (CODE_SIGNING_ALLOWED=NO).
- Sandbox test `tests/capture-service.test.ts` (boot on port 0, /health shape,
  status-file contract, flags-off defaults, 501/404 conventions) green via
  `make remote-test`.

Next: M1 — websocket ingress per spec §4 (token auth, acks, resume, dedupe),
session store, fixtures, replay client.

## M1 — Ingress and wire protocol (2026-08-13)

Shipped:
- `lib/ingress.mjs`: one websocket per session at `/capture/stream`, Bearer
  `CAPTURE_TOKEN` on the upgrade (timing-safe digest compare; 403 disabled /
  403 unsealed / 401 bad token, each counted). Binary media framing
  `[u8 kind][u32 seq][f64 ts][u32 len]` (kind 0 = Opus packet, 1 = JPEG
  still); per-stream contiguous acks `{type:"ack", stream, seq}` — stream-
  tagged because two interleaved streams share one socket. Sessions survive
  socket drops and process restarts (resume answers both high-water marks);
  an ended session refuses to reopen (dedupe by session id); a reconnect
  supersedes its own dying socket; idle sessions close with reason
  "timeout". Malformed session_start closes 1008 with no state created.
  Session records are deterministic (no server wall-clock) — invariant I7's
  byte-identical double replay holds for the whole store.
- `lib/media-log.mjs`: append-only framed Opus log per session (one file, not
  180k inodes), JPEG stills one file per seq; only next-expected seqs are
  ever persisted, with a bounded reorder buffer (256) and dedupe-with-ack for
  everything at or behind the edge; high-water recovered by scanning the log
  (the log is the authority, a truncated crash tail is skipped dead bytes).
- Server surfaces: `POST /capture/devices` (APNs token registry, idempotent),
  `GET /capture/sessions` + `/capture/sessions/<id>` (authed read API for the
  replay client and the M2 view), flag-off answers moved 501 -> 403 for the
  implemented routes. `ws` resolves from the repo root like kanban-loop's.
- Fixtures: real recorded speech as raw Opus packets (Joana pt_PT command,
  Samantha en_US command, pt ambient, en near-miss with Zeca in object
  position; 134-197 packets each) via `scripts/make-fixtures.sh` (macOS
  say + ffmpeg + an Ogg-page parser in python, committed for regeneration);
  JPEG still set; malformed session.
- `scripts/replay-client.mjs`: full-protocol driver in the speak.mjs shape —
  follows every injection to the stored session record and the counters,
  prints the effect or says nothing arrived, states its coverage limits in
  the header (starts at the wire, not at sound; Deepgram not under test;
  byte-identical proof lives in the disk-access test). Modes: run
  (--twice / --drop-at / --mode screen_audio), bad-token, malformed.

Tests (19, green on dev-madrid): end-to-end session with per-stream acks;
duplicate replay acked-at-edge with byte-identical store hash; refused reopen
after end; resume-after-drop from last acked seq; out-of-order reassembly;
bad token counted; disabled 403; malformed close without state; idempotent
device registry; idle timeout; the replay client run as a real subprocess
over the committed fixtures (drop at 50, --twice, effect-following) plus its
refusal modes.

Next: M2 — Deepgram live client (mocked in tests, env-gated real-key smoke),
per-session transcript store, live transcript view + session list/detail.
