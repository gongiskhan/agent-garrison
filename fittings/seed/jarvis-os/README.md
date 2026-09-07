# Jarvis Agentic OS

An optional voice HUD for Garrison. It serves a dedicated React view with an
audio-reactive Three.js core, transcript, workspace panels and colour settings.
It sends turns through the configured HTTP gateway on its own `jarvis` channel.

Tap the core or press Space to start a hands-free session. Speech detection runs
in the browser; completed segments go to the composition's selected voice
provider for transcription. Space interrupts a reply; M mutes the microphone.
Stopping the session releases the microphone. Esc closes an open report.

## Voice contract

The runner supplies `GARRISON_VOICE_FITTING_ID`. The server checks that provider's
readiness and advertises its actual STT, TTS and wake-event capabilities through
`GET /api/voice`. The HUD refreshes readiness after a provider restart.

Capture Service uses authenticated REST STT and MP3 TTS. Its `CAPTURE_TOKEN` is
delivered through the fitting's secret scope and stays on the server. Optional
Local Voice supplies WAV TTS and may advertise wake events. The HUD connects to
wake events only when supported; it does not assume an audio streaming endpoint.

Replies are divided at the provider's advertised text limit without dropping
the remaining text. TTS uses JSON POST requests and plays decoded audio through
the browser AudioContext. Interrupting aborts pending synthesis and prevents a
late response from restarting playback. STT requests have bounded deadlines.

## Runtime and sessions

`/api/runtime` describes gateway and voice health plus current skills and
commands. `/api/sessions` uses the shell's canonical mesh inventory, including
recent native shell sessions and their working state. The separate dev-session
controls operate only on sessions owned by Dev Env; observed sessions remain
read-only.

## Build and stationing

The fitting is available in the registry and is not stationed automatically.
Select it in a composition with an HTTP gateway and a voice provider. Its port
comes from the composition and instance profile, and deployment publishes its
view through the normal tailnet mapping.

Setup runs `ui/build.mjs` using the root lockfile's React, Three.js, VAD and ONNX
dependencies. It builds the JavaScript bundle and copies the browser VAD model,
worklet and WASM assets into `dist/`; generated assets are not committed. The
tracked `dist/index.html` is the entry point. No model assets are fetched by the
browser from an external CDN.

The HUD is a dedicated fitting view. Colour preferences autosave; it does not
install a floating overlay in the Garrison shell.

## Provenance

The original visual work came from the Fable `jarvis-hud` reference, including
the dithered core and report overlay. The current default is `GraphCore`.
Garrison owns the transport, provider selection and session integration.
