# Jarvis Agentic OS

A **voice-first, Jarvis-style HUD** for Agent Garrison — a central audio-reactive
core you talk to. Hold to talk, it sends to the Operative through the gateway,
streams the reply, and reads it aloud while the core pulses to the audio.

It is an own-port channel Fitting: it serves its own React HUD and talks to the
Operative through the **http-gateway** (the same proven path as
`web-channel-default`) and to a **kind:voice** Fitting for STT/TTS. It never
spawns Claude itself.

## Architecture

```
  browser HUD ──/api/chat──▶ jarvis-os (Node, :7092) ──▶ http-gateway ──▶ Operative
   DitherCore                 clone of web-channel server         (Orchestrator)
   push-to-talk  ──/api/voice/{stt,tts}──▶ kind:voice Fitting (local-voice / deepgram-voice)
```

- **`scripts/server.mjs`** — cloned from `web-channel-default`. Proxies
  `/api/chat` → gateway `/chat/stream`, discovers the voice Fitting
  (`local-voice.json` → `deepgram-voice.json`), and proxies `/api/voice/*`.
  Reuses the gateway's `"web"` channel ring buffer, so station **either**
  `jarvis-os` **or** `web-channel-default`, not both.
- **`ui/`** — the HUD. Visual layer reused from the Fable jarvis-hud reference;
  voice + transport logic is the Garrison-native path from web-channel.

### The core (audio-reactive)

`ui/cores/DitherCore.tsx` + `ui/cores/dithering-shader.tsx` render a dithered
sphere on **WebGL2 (no three.js)**, so the bundle stays light. The host passes a
real `getLevel` — an `AnalyserNode` RMS over the mic while listening and over
the TTS `<audio>` while speaking — so the sphere mouths the live audio. Modes
(`idle` / `listening` / `working` / `speaking` / `error`) drive colour + speed.

**Stable Core boundary:** the HUD renders `<DitherCore mode getLevel />`.
Swapping to the heavier, more "Jarvis" `GraphCore` later is just changing that
import and adding `three` to the build — `getLevel`/`mode` stay identical.

### Interaction (v1)

Push-to-talk: **hold Space** (or press-and-hold the core) to record, release to
send. STT is the batch `/stt` path (works with `local-voice`, which has no
streaming `/stream` in v1). Esc closes the report overlay. Replies pop a callout
and are read aloud.

## Build

`ui/build.mjs` (esbuild) runs on every `up` (the Fitting's `setup`), resolving
`react`/`react-dom` from the Garrison root and writing `dist/`. There is no
three.js dependency.

## Compose

See `compositions/jarvis/apm.yml`: `jarvis-os` + `local-voice` + `http-gateway`
+ `garrison-orchestrator` + `memory`. `voice` is a singleton, so exactly one
voice Fitting is stationed (`local-voice` here).

## Provenance

The visual layer (`ui/cores/DitherCore.tsx`, `ui/cores/dithering-shader.tsx`,
`ui/ReportOverlay.tsx`, and the report-overlay CSS) is reused from the Fable
`jarvis-hud` reference project. The Garrison adaptations: the Core's `getLevel`
is wired to a real AnalyserNode, the import path was localised, and the
transport/voice loop is the web-channel Garrison-native path rather than the
Fable Next.js API routes.
