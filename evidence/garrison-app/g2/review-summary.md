# G2 adversarial review - what it found and what changed

The G2 working tree (one voice layer: capture-service provides `voice`,
deepgram-voice unstationed, the shell and dev-env proxy `/voice/*` to it,
omi-channel forwards to it) went through a multi-agent review before this
evidence was produced: independent finders per dimension (voice REST
contract, secrets and env, lifecycle, omi ingress, docs and manifests, tests),
each finding then handed to a verifier asked to refute it. 28 findings came
back; the first 9 are marked JUDGED (finder + verifier agreed), the other 19
UNVERIFIED: the review hit its session limit before every verifier reported,
so those 19 were judged directly against the code here, one by one, before
anything was changed. Nothing was dismissed for being unverified.

27 of the 28 findings are resolved in the working tree this evidence covers;
one (8) is mitigated and carried as a named follow-up. Each bucket below says
which. A first draft of this file claimed findings 1, 2, 4, 7, 8 and 9 fixed
before they were; a grep of the tree caught that, and those six were then
fixed (1, 2, 4, 7, 9) or honestly downgraded (8) before anything was
committed. The decisions file records the design-level consequences as D30
(`docs/decisions/2026-09-garrison-app.md`).

## By bucket

### Voice contract (5, 11, 12, 14, 17, 19, 20, 23) - fixed
- 5 / 11: browsers chunked read-aloud at 1800 chars against a `/tts` that
  rejects over 600. One chunker now: `@garrison/claude-chat/voice`
  (`chunkSpeech`, `chunkCharsFor`), driven by the `maxTextChars` the provider
  advertises on `/health`; talk's `voice-clip.ts` re-exports it.
- 12: read-aloud gated on `ttsUsable = voiceUsable && health.tts !== false`;
  the mic keeps `voiceUsable`.
- 14 / 19: health proxies honour `voice.restEnabled`; the reason vocabulary
  gained `"voice rest disabled"`.
- 20 / 23: `"capture token not sealed"` and `"voice provider not running"`
  are distinct reasons; the talk UI shows the host's reason instead of one
  fixed string (17).

### Secrets and env (13, 18, 21, 22) - fixed
- 13 / 18: dev-env received CAPTURE_TOKEN and handed it to every PTY. `ptys.mjs`
  strips `PTY_ENV_DENY` (today `CAPTURE_TOKEN`) from the PTY env;
  `tests/dev-env-pty-env.test.ts` keeps the list in lockstep with the
  manifest's `secret_scope`.
- 21: `secretsDelivered` derives from vault state, not env presence; the
  unlock heal re-projects the full env (`desiredEnvForFitting`).
- 22: `connector.secrets` outside `secret_scope` is now a manifest ERROR
  (`metadata.ts` superRefine).

### Proxy robustness (7, 15, 16) - fixed
- 15: talk and dev-env voice proxies bound upstream at 20000ms, drain and
  `413` + `Connection: close` an over-cap `/stt`, tear down on client close.
  Upstream Deepgram/ElevenLabs calls carry `AbortSignal.timeout` (60s/20s).
- 16: health bodies name the provider `fitting`, never its loopback URL.
- 7: `handleVoiceProxy` carries `?language=` (the one query parameter the
  provider's `/stt` reads) to the upstream and nothing else from the page's
  query; `tests/talk-voice-router.test.ts` pins both halves.

### Omi channel (1, 2, 3, 4, 25) - fixed
- 1: `RealtimeForwarder.push` chains the batches of one session (a promise
  chain per session id, dropped when it drains), so the fire-and-forget calls
  from `ingress.mjs` reach the wake bus in the order the wearer spoke;
  sessions still forward concurrently. Test: a held first batch of session a
  does not delay session b, and a-second waits behind a-first.
- 2: the forwarder derives the voice layer's status file from `cfg.home` (the
  home the config was loaded with) via `captureStatusFile(cfg)`; `process.env`
  is consulted only for the test-runner guard that refuses the real
  `~/.garrison` under vitest.
- 3 / 4: status page lists CAPTURE_TOKEN in the credentials table; forward
  readiness goes red after a rejected or failed forward (`lastFailure`, ordered
  by an outcome counter, not the clock) and green again on the next batch that
  lands, so `/health` cannot read "forwarding" through a peer that rejects
  everything.
- 25: envelope and `realtime_malformed` regressions have tests again
  (`tests/omi-channel-forward.test.ts`).

### Automations connector (9 fixed, 8 mitigated - follow-up)
- 9: `synthesize` returns `{clip_id, clip_path, mime, bytes, backend}`; the
  mp3 stays on the voice layer at `/speak/<clip_id>.mp3` (content-addressed,
  unauthenticated by design like the other own-port surfaces) and
  `audio_base64` rides along only with `inline: true`, or when the service
  named no clip. Catalog, manifest, D26 text and
  `tests/capture-service-connector.test.ts` updated together.
- 8: NOT fixed at the transport. `defaultRunConnector` in
  `fittings/seed/automations/lib/connector-invoke.mjs` still hands the action
  args to `connector.mjs` as one argv element, so an `audio_base64` clip is
  bounded by the OS single-argument ceiling, far under the service's 8 MB cap.
  Mitigation shipped: the `transcribe` catalog entry and the manifest say so
  and point at the `path` argument for anything over about 100 KB. The real
  fix is a protocol change every connector must understand (args over stdin
  or a temp file); it is listed in the G2 follow-ups and the handoff, not
  buried here.

### Config (6) - fixed
- The D25 active-conversation window already parsed through
  `parseNonNegativeIntOr`; the two pre-existing knobs whose manifest text says
  "0 disables" (`transcribe_mute_timeout_ms`, `wake_progress_interval_ms`)
  still went through `parseIntOr`, which maps 0 to the default. Both now use
  the non-negative parser; their consumers already treated 0 as off.
  `tests/capture-service.test.ts` covers all four.

### Docs, manifests, tests (10, 24, 26, 27, 28) - fixed
- 10: the D26 fixture encodes the shipped contract (connector sealed on
  CAPTURE_TOKEN alone).
- 24: the committed `apm.lock.yaml` is the one-hunk removal; the Mac's APM
  0.11.0 regeneration is never committed (see `redeploy.txt`).
- 26 / 27: `docs/INSTANCES.md` rewritten on the 8xxx map; the phantom
  Orchestrator `port: 8087` config dropped from both compositions (the
  Orchestrator binds nothing; 8087 is whatsapp-web's).
- 28: the idle-close test's margin is 600ms/100ms, not 120ms/70ms.

## Contested finding
Finding 20 ("voice locked" reported for an unsealed token) was argued
against by its verifier on the grounds that the two states were
operationally the same. They are not: an unlocked vault with no CAPTURE_TOKEN
is a one-time setup task, a locked vault is a per-boot one, and the disabled
mic should say which. Both reasons exist now.

## Pre-existing debt the review surfaced (fixed here, not G2-caused)
- stale 7xxx/27xxx port prose across INSTANCES.md (rewritten) and several
  fitting summaries (recorded for follow-up, not rewritten here);
- `tests/e2e/primary-runtime.spec.ts`, dead since 2026-07-20 (spawned a
  deleted server, asserted a page that no longer exists) - removed; its
  coverage lives in `tests/orchestrator-policy-store.test.ts` and
  `tests/e2e/muster-orchestrator.spec.ts`;
- capture-service's live-transcript SSE route never flushed its headers, so
  a quiet session's EventSource sat "connecting" for the 15s keepalive
  (and its test took 15s). `res.flushHeaders()` there and on the same shape
  in drill and automations;
- the full vitest run was load-flaky in the ~30 suites that launch Chromium
  on fixed ports: hooks timed out under the parallel run, and a timed-out
  afterAll left fixture servers squatting ports for every later suite.
  `vitest.workspace.ts` now runs those suites as their own `singleFork`
  project after the parallel body (`tests/setup-single-fork.ts` restores
  `process.env` between files). See `vitest.txt`.
