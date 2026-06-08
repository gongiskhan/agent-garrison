# Voice (Deepgram) + Trello task management — handoff / starting point

**Status:** shipped and committed on `main` (commits `7bb93fe`, `22f3804`,
`cedcde3`). Validated live (real Deepgram key, fake-audio Playwright drivers,
and a real composition round-trip that created + verified a Trello card). This
doc is the starting point for continuing the feature on a worktree.

> Interaction with the config-plane work: the **Quarters pivot** (see
> [`CLAUDE_CONFIG_PLANE_HANDOFF.md`](./CLAUDE_CONFIG_PLANE_HANDOFF.md)) collapsed
> the 24 Faculties into 6 roles. The standalone `voice` Faculty/capability kind
> introduced here was **folded into the `channels` role** with an `own_port`
> flag (`fittings/seed/deepgram-voice/apm.yml` now declares
> `faculty: channels`, `own_port: true`, `default_port: 7085`). The runtime
> behaviour is unchanged; only the metadata classification moved. Where this doc
> says "voice Faculty", read "channels-role own-port voice Fitting" on merged
> `main`.

---

## 1. What it is

Two capabilities reachable through the **web channel** (the mobile-first browser
chat surface, port 7083):

1. **Voice in/out** via Deepgram — push-to-talk speech-to-text, read-aloud
   text-to-speech, and a hands-free conversation loop.
2. **Trello task management** — the Operative can read/write Trello cards
   ("add a task to A Fazer: …") in response to a channel message.

Positioning is unchanged: local-first, single-user, localhost; phone access is
via the Tailscale tunnel. The Deepgram API key **never reaches the browser** —
it lives in the vault and is injected server-side into the voice Fitting.

---

## 2. Architecture

```
Browser (web-channel UI, 7083)
  │  mic → PCM (16 kHz, resampled in-browser)         speaker ← audio
  │                                                          ▲
  ├── WS  /api/voice/stream  ──┐                    POST /api/voice/tts
  ├── POST /api/voice/stt      │  (same-origin proxy; key stays server-side)
  │                            ▼
web-channel server (scripts/server.mjs)
  ├── pure passthrough WS  ─────────────►  deepgram-voice Fitting (7085)
  ├── binary HTTP proxy /stt,/tts ───────►   ├── POST /stt  → Deepgram /v1/listen (batch)
  │                                          ├── POST /tts  → Deepgram /v1/speak
  │                                          └── WS  /stream → Deepgram live /v1/listen
  └── POST /api/chat / GET /api/stream ──►  http-gateway (4777) ──► Operative (real Claude)
                                                                      └── runs trello.py (Bash)
```

- **`deepgram-voice`** (own-port Fitting, default **7085**) owns all Deepgram
  calls. Reads `DEEPGRAM_API_KEY` from env (injected from the vault — see §4).
- **`web-channel-default`** consumes voice and exposes same-origin proxies so the
  browser never sees the key. It also proxies chat to the `http-gateway`, which
  routes to the real Operative.
- **`trello-data-source`** provides the `trello` CLI the Operative shells out to.

---

## 3. Key files

**Voice Fitting** — `fittings/seed/deepgram-voice/`
- `scripts/server.mjs` — HTTP `/health`, `/stt`, `/tts`, status page `/`; **WS
  `/stream`** (live STT). `/stream` opens Deepgram's live socket with
  `endpointing`, `utterance_end_ms` (silence threshold, client-set), `vad_events`,
  `interim_results`; accumulates finals and emits `{ready|speech_started|
  transcript|utterance_end|error}`.
- `scripts/start.mjs`, `scripts/probe.mjs`, `README.md`, `apm.yml`.

**Web channel** — `fittings/seed/web-channel-default/`
- `scripts/server.mjs` — `GET /api/voice` (discovery, mirrors the Monitor
  pattern via `~/.garrison/ui-fittings/deepgram-voice.json`); **binary** proxies
  `POST /api/voice/stt|tts` (the existing SSE/JSON helpers can't carry audio);
  **pure-passthrough WS** `/api/voice/stream` (forwards query incl.
  `sample_rate`/`utterance_end_ms`); optional **HTTPS** via `tls_cert`/`tls_key`
  for phone mic capture.
- `ui/main.tsx` — the whole client: batch + streaming capture, the voice **state
  machine** (`idle → arming → listening → speaking`), the three toggles, the
  status/indicator banner, and the mobile **audio-unlock**.
- `ui/styles.css`, `README.md` (incl. the `tailscale serve` HTTPS recipe),
  `apm.yml`.

**Trello** — `fittings/seed/trello-data-source/`
- `scripts/trello.py` — stdlib-only CLI: `--probe`, **`lists`** (added — the
  orchestrator had no way to discover list ids), `list <id>`, `create <listId>
  <name>`, `move`, `archive`, `comment`. Reads `TRELLO_KEY`/`TRELLO_TOKEN`/
  `TRELLO_BOARD_ID` from the materialized `.env`.
- `apm.yml` — the **`for_consumers`** block documents those verbs so the runner
  injects them into the Operative's assembled prompt (this is what makes the
  Operative actually able to manage tasks).

**Garrison core**
- `src/lib/own-port-lifecycle.ts` — **`vaultEnvForEntry(entry)`**: injects vault
  secrets into an own-port spawn **only** when the Fitting declares
  `consumes: vault` (no leakage); tolerant of a locked vault. This is how the
  Deepgram key reaches the voice Fitting.
- `src/lib/runner.ts` (`startOperativeBoundFittings`) and
  `src/app/api/fittings/[id]/start/route.ts` — both call `vaultEnvForEntry`.
- `src/lib/types.ts`, `src/lib/faculties.ts` — originally added the `voice`
  faculty + capability kind (since folded into `channels` by the Quarters pivot).

**Tests** — `tests/{capabilities,faculties,seed,own-port-lifecycle}.test.ts`
(capability wiring, faculty list, seed metadata, the vault-injection gating).

**Spike drivers** (not unit tests — real-browser/real-Deepgram validation) —
`scripts/spike/`:
- `voice-stream-check.mjs` — node client proving the Deepgram **live** contract
  (phrase+silence → `utterance_end` with transcript; pure silence → nothing).
- `voice-stream-e2e.mjs` — fake-audio Chromium driving the full streaming chain
  incl. the hands-free loop (`listening→speaking→arming→listening`).
- `voice-e2e.mjs` — batch-path browser e2e.
- `voice-vault-check.ts` — proves `vaultEnvForEntry → startOwnPortFitting`
  delivers the key (`keyConfigured:true`).
- `fake-audio-webaudio-check.mjs` — isolation check that fake audio flows
  through the Web Audio graph.
- `voice-phone-demo.mjs` — standalone phone demo (voice + web-channel + a mock
  gateway) for testing the voice loop without booting the real Operative.
- `fixtures/` — `voice-input.wav` (TTS phrase), `voice-input-silence.wav`
  (phrase + 2.5 s silence), `silence.wav`.

---

## 4. How it works (the non-obvious parts)

- **Secret delivery.** Own-port Fittings are spawned detached with a copy of
  `process.env` only — they do **not** see the composition's materialized
  `.env`. `vaultEnvForEntry` closes that gap for `consumes: vault` Fittings. The
  Deepgram key is stored in the vault as `DEEPGRAM_API_KEY`; on `up` (or manual
  start) it's injected into the voice Fitting's env. `GET /health` reports
  `keyConfigured`.
- **Streaming + silence endpointing.** The browser captures at the device's
  native rate (don't fight iOS, which ignores a requested 16 kHz),
  **resamples to 16 kHz in JS**, and streams linear16 PCM. Deepgram emits
  `UtteranceEnd` after `utterance_end_ms` of silence → that's the auto-send
  trigger. Default **5000 ms** (a normal mid-sentence pause is ~1–2 s);
  overridable with `?silence_ms=<n>` on the page URL (clamped 1000–20000), which
  the UI forwards as `utterance_end_ms` on the WS.
- **Loop-safety guard.** On `utterance_end`, empty/sub-word transcripts are
  dropped silently — prevents the mic opening into ambient noise (or speaker
  bleed) and auto-sending into a self-talk loop. `getUserMedia` also requests
  `echoCancellation/noiseSuppression/autoGainControl`.
- **Hands-free.** After a reply's TTS finishes (`audio.onended`), if hands-free
  is on, a visible ~2 s **arming** countdown runs, then the mic re-opens. The
  mic is **never** open while TTS is playing (barge-in is explicitly out of
  scope). Enabling hands-free turns Read-aloud on (there must be a voice to
  follow).
- **Mobile audio unlock.** Mobile autoplay policy blocks programmatic
  `Audio.play()` until a user gesture. The UI reuses **one** `<audio>` element
  and primes/unlocks it on the first toggle/mic/send tap, so read-aloud
  auto-plays without first tapping a speaker.
- **Deepgram contract (verified live):**
  - STT batch: `POST /v1/listen?model=nova-2&smart_format=true&punctuate=true`,
    `Authorization: Token <key>`, binary audio body → transcript at
    `results.channels[0].alternatives[0].transcript`.
  - STT live: `wss://api.deepgram.com/v1/listen?...&encoding=linear16&
    sample_rate=<n>&interim_results=true&endpointing=300&utterance_end_ms=<n>&
    vad_events=true` → `Results` (with `is_final`/`speech_final`),
    `SpeechStarted`, `UtteranceEnd`.
  - TTS: `POST /v1/speak?model=aura-asteria-en` (+`encoding=linear16&
    container=wav&sample_rate=16000` for wav) → audio bytes (mp3 by default).

---

## 5. Trello task management

The Operative is a real Claude Code instance with Bash, so it just runs the
`trello.py` CLI. What makes it *know* it can: the `for_consumers` block on
`trello-data-source/apm.yml` is injected into the assembled prompt under the
`data-source:trello` capability line (verified present in the rendered block).

**Proven live round-trip** (default composition, real Operative): a web-channel
message *"add a task to the 'A Fazer' list named X"* → the Operative ran
`trello.py lists` then `trello.py create 692ef0efcda3c6ad22f446b0 "X"` → the card
was independently confirmed on the board (then archived). Board id `vl1Z8KFH`;
"A Fazer" list id `692ef0efcda3c6ad22f446b0`.

---

## 6. How to run / test

**Unit + validation**
```
npm test            # vitest (incl. voice capability/seed/gating specs)
npm run typecheck
tsx scripts/validate-fitting.ts fittings/seed/deepgram-voice   # four-check PASS
```

**Voice loop in isolation (no real Operative)**
```
DEEPGRAM_API_KEY=<key> node scripts/spike/voice-stream-check.mjs   # live contract
DEEPGRAM_API_KEY=<key> node scripts/spike/voice-stream-e2e.mjs     # full chain + hands-free
DEEPGRAM_API_KEY=<key> node scripts/spike/voice-phone-demo.mjs     # phone demo (mock replies)
```

**Real agent (prod) — voice + Trello end to end**
1. Ensure the vault holds `DEEPGRAM_API_KEY` (+ `TRELLO_KEY/TOKEN/BOARD_ID`).
2. `VAULT_UNLOCKED=true npm start` (loads the code; dev-unlocks the vault).
3. `POST http://127.0.0.1:7777/api/runner/default/up` (or Run → up). On `up`,
   `deepgram-voice` should report `keyConfigured:true`.
4. Phone over HTTPS: `tailscale serve --bg --https=8444 http://127.0.0.1:7083`,
   then open `https://<host>.<tailnet>.ts.net:8444` (must be on the tailnet;
   HTTPS is required for mic capture).

---

## 7. Known limitations / next steps

- **Mobile mic needs HTTPS.** Handled via `tailscale serve` (or the
  `tls_cert`/`tls_key` option). Plain-http LAN cannot capture audio (TTS is
  unaffected). Funnel (public) would also work but exposes publicly.
- **No barge-in.** You can't interrupt the agent by talking over it; the mic is
  gated closed during TTS. Real barge-in needs AEC + always-on streaming VAD.
- **Silence threshold** is a single global default (5 s). Consider a UI slider
  (the `?silence_ms=` plumbing already exists end-to-end).
- **The streaming e2e is harness-bound:** the mobile autoplay-unlock itself
  can't be reproduced headless (it needs a real mobile gesture) — verified by
  reasoning + the standard pattern, with the phone as the real check.
- **Roles-pivot follow-through:** confirm the voice/web-channel Fittings behave
  correctly as `channels`-role own-port Fittings after the Quarters merge
  (runtime own-port start/stop is driven by the `own_port` metadata flag now,
  not a faculty membership set).
- **Possible enhancement:** wire the Trello-backed derived Tasks truth file
  (`tasks/trello.md`) to refresh after the Operative mutates cards.
