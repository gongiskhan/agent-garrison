# web-channel-default

Mobile-first browser chat surface (default port **7083**). Relays browser turns
to the http-gateway and streams replies back. Provides the `channel:web`
capability.

## Voice (push-to-talk + read-aloud)

When a `kind:voice` Fitting (e.g. `deepgram-voice`) is stationed, the UI shows:

- a **mic button** — tap to talk. Audio streams to Deepgram live over
  `WS /api/voice/stream`; you don't press stop — Deepgram's silence endpointing
  ends the utterance. Tapping the mic is always an interrupt/abort.
- a **speaker button** on each reply — reads that reply aloud via `/api/voice/tts`;
- a **"Read aloud" toggle** — auto-speaks every completed reply;
- an **"Auto-send" toggle** — when you stop talking (silence), the transcript is
  sent automatically; off → it fills the composer for review;
- a **"Hands-free" toggle** — after each spoken reply, the mic re-opens
  automatically (a visible ~2s "Listening in Ns…" countdown, then a live
  "Listening…" indicator with a level meter). The mic never opens while the
  agent is still speaking. Enabling hands-free turns Read-aloud on.

A loop-safety guard drops empty/sub-word transcripts so the mic opening into
ambient noise never auto-sends. All voice traffic goes through this Fitting's
same-origin proxy (`/api/voice/*`, plus the `/api/voice/stream` WebSocket which
is a pure passthrough to the voice Fitting), so the browser never sees the
Deepgram API key. Voice controls are hidden when no voice Fitting is running
(`GET /api/voice` reports `available:false`). A batch `POST /api/voice/stt` path
remains as a fallback when the browser can't stream (no AudioContext).

Two URL query params for testing/tuning:

- `?silence_ms=<n>` — override the streaming silence-endpointing window
  (default 5000 ms, clamped to Deepgram's 1000–20000);
- `?voice=batch` — force the batch MediaRecorder fallback even in a browser
  that could stream (tap mic to record, tap again to stop → `/api/voice/stt`
  → auto-send). Used by `scripts/spike/voice-e2e.mjs` to drive the fallback;
  without it the batch path is unreachable in any capable browser.

## Mobile / phone voice input needs HTTPS

`getUserMedia` (mic capture) only works in a **secure context**. `localhost` /
`127.0.0.1` count as secure, so desktop and Playwright are fine. A phone hitting
a LAN IP over plain `http` does **not** — the browser blocks the mic (read-aloud
/ TTS still works). Two ways to get a secure context on the phone:

### Option 1 — `tailscale serve` (recommended)

No cert management; Tailscale provides a real Let's Encrypt cert for your
tailnet hostname:

```bash
# web-channel listening on 127.0.0.1:7083 (default bind)
tailscale serve https / http://127.0.0.1:7083
```

Then open `https://<machine>.<tailnet>.ts.net/` on the phone (must be on the
tailnet). Mic capture works because the origin is https.

### Option 2 — built-in TLS

Point the Fitting at a cert/key (config `tls_cert` / `tls_key`, or env
`WEB_CHANNEL_TLS_CERT` / `WEB_CHANNEL_TLS_KEY`). Use [`mkcert`](https://github.com/FiloSottile/mkcert)
for a locally-trusted cert, then set `bind_host: 0.0.0.0`:

```bash
mkcert 127.0.0.1 <machine>.local <your-lan-ip>
# -> ./<...>.pem (cert) and ./<...>-key.pem (key)
```

The server serves https when both files are present and readable; otherwise it
falls back to plain http.
