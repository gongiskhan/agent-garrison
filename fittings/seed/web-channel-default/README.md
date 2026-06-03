# web-channel-default

Mobile-first browser chat surface (default port **7083**). Relays browser turns
to the http-gateway and streams replies back. Provides the `channel:web`
capability.

## Voice (push-to-talk + read-aloud)

When a `kind:voice` Fitting (e.g. `deepgram-voice`) is stationed, the UI shows:

- a **mic button** — push to talk; on stop the audio is sent to
  `/api/voice/stt` and the transcript is auto-sent as a message;
- a **speaker button** on each reply — reads that reply aloud via
  `/api/voice/tts`;
- a **"read aloud" toggle** — auto-speaks every completed reply.

All voice traffic goes through this Fitting's same-origin proxy
(`/api/voice/*`), so the browser never sees the Deepgram API key — it stays on
the voice Fitting. Voice controls are hidden when no voice Fitting is running
(`GET /api/voice` reports `available:false`).

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
