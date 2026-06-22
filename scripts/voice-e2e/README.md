# voice-e2e — autonomous voice test harness

Tests the jarvis voice pipeline **end to end with no microphone and no human**.
macOS `say` synthesizes the test audio (native **pt-PT / pt-BR / en** voices — the
workaround for Deepgram TTS being English-only), then the audio is fed through the
real running Fittings. Using an independent TTS for generation also keeps the STT
test honest (not a circular Deepgram-into-Deepgram loop).

## Levels

| Level | Path | Asserts |
|-------|------|---------|
| **A** | audio → `deepgram-voice` `POST /stt?detect_language=true` | transcript similarity ≥ threshold **and** detected language (pt/en) |
| **B** | audio → `deepgram-voice` `WS /stream` (20 ms linear16 frames + silence tail) | `utterance_end` fired (endpointing) **and** transcript similarity |
| **C** | audio → `jarvis-os` `/api/voice/stt` → `/api/chat` (Orchestrator) → `/api/voice/tts` | non-empty reply **and** spoken audio returned |

Similarity is word-level `1 − WER`, accent-folded (a missing diacritic doesn't
tank the score). Focus order in `corpus.json`: pt-PT (voice Joana) > pt-BR
(Luciana) > en.

## Voice Fitting — local-voice (no account) vs deepgram-voice (cloud)

The harness auto-discovers whichever voice Fitting is running:

- **`local-voice`** (port 7090) — fully **local, no account, no API key**
  (faster-whisper STT, multilingual with language detection). The default. Batch
  `/stt` only, so **level B (streaming) is skipped** — it has no WS `/stream`.
- **`deepgram-voice`** (port 7085) — cloud, needs a **Deepgram account +
  `DEEPGRAM_API_KEY` in the vault**. Adds live `/stream`, so **all three levels**
  run; generally more accurate, especially on short utterances.

Both expose the same `/stt` contract (`{ transcript, confidence, detected_language }`),
so levels A and C work against either with no change.

`local-voice` is the composition's active voice; `deepgram-voice` stays installed
(not selected) purely as a benchmark reference. To run a head-to-head, start it so
it gets the vault key injected, then use `--compare`:

```bash
curl -X POST http://127.0.0.1:7777/api/fittings/deepgram-voice/start   # 7085, key from vault
node scripts/voice-e2e/run.mjs --compare                               # local-voice vs deepgram
```

`--compare` also honors `LOCAL_VOICE_URL` / `DEEPGRAM_VOICE_URL` env overrides to
point at an ad-hoc instance (e.g. an unpinned or larger-model local-voice on a
spare port) without touching the running one.

## Prerequisites

1. The **jarvis composition is `up`** (so a voice Fitting, and for level C
   `jarvis-os` + gateway, are running). The harness discovers their ports from
   `~/.garrison/ui-fittings/*.json`.
2. For **deepgram-voice only**: `DEEPGRAM_API_KEY` in the Garrison vault. The
   harness holds no secret — it talks to the running Fitting, which carries the
   vault-injected key. `local-voice` needs no key.
3. macOS voices installed: **Joana** (pt-PT), **Luciana** (pt-BR), **Samantha** (en).
   Add missing ones in System Settings → Accessibility → Spoken Content → System
   Voices. List with `say -v '?'`.

## Run

```bash
node scripts/voice-e2e/run.mjs                          # all levels, all langs
node scripts/voice-e2e/run.mjs --level=a --langs=pt-PT  # just STT+language, European Portuguese
node scripts/voice-e2e/run.mjs --level=a,b --limit=2    # STT + streaming, 2 phrases each
node scripts/voice-e2e/run.mjs --threshold=0.7 --json   # stricter pass bar + machine output
```

Exit code is non-zero if any check fails. Synthesized audio is cached under
`fixtures/` (git-ignored) keyed by voice+text, so re-runs don't re-synthesize.

## Files

- `corpus.json` — phrases per language (edit freely; mix commands, questions, numbers).
- `synth.mjs` — `say` wrapper → 16 kHz mono linear16 WAV, with fixture cache.
- `lib.mjs` — Fitting discovery, WAV parsing, similarity scoring, SSE parsing.
- `run.mjs` — orchestrates levels A/B/C and prints the report.

## Language detection note

`deepgram-voice` `/stt` and `/stream` accept `?language=<code>` and
`?detect_language=true` (added for this harness). Detection is asserted on level A
(prerecorded, reliable); level B streaming uses an explicit per-language `language`
because live nova-2 doesn't do reliable detection.
