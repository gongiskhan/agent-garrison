# http-gateway

A small local HTTP gateway that owns the Claude Code session for an
Operative. Channel Fittings (Slack, etc.) call this gateway to push
inbound messages and read replies.

## Endpoints

- `GET /health` — liveness probe; returns `{ ok, session_id, uptime_ms }`.
- `POST /chat` — synchronous turn, returns `{ reply, session_id, cost_usd }`.
- `POST /chat/stream` — SSE stream emitting `open`, `chunk`, `tool`,
  `done`, `error` events. Long-lived connection with 15s keepalive.
- `POST /attachments` — uploads a binary attachment for the next turn.
- `POST /jobs` — fire-and-forget job; queued through the gateway's
  FIFO `inflight` chain. Returns `{ ack: true }` (HTTP 202).

All POST routes serialize through a single in-process `inflight`
Promise chain, so concurrent requests are paired in arrival order
against the underlying Claude session — preserving the FIFO turn
guarantee the channels rely on.

## Slack adapter compatibility (decided 2026-05-06)

The Slack channel Fitting (`fittings/seed/slack-channel/`) calls
this gateway via the synchronous `/chat` endpoint — **no aliasing,
no SSE subscriber**. Per inbound Slack message:

1. Slack adapter receives webhook, ACKs Slack within 3s.
2. Adapter POSTs the user text to `POST /chat` and awaits the
   reply (the gateway holds the connection until the turn ends).
3. Adapter posts the reply back to Slack via `chat.postMessage`,
   threaded under the original message.

This trades the awc-gateway-slack model's decoupled `/inbound` +
SSE `/events` pattern for a simpler request/response — fine for
v1 since Slack delivers the reply via a separate threaded post
anyway. Long-running turns are tolerated by the gateway's
`inflight` Promise chain; concurrent Slack messages serialize.

## Default port

The default bind is `127.0.0.1:4777` (set in `apm.yml`). Override
via the `port` and `bind_host` config keys per composition. Channel
Fittings should read the gateway URL from `GATEWAY_URL` (env) and
fall back to `http://127.0.0.1:4777`.

## Verify

The verify hook checks the script file exists. The runner-side
readiness probe in `src/lib/runner.ts` separately polls `/health`
for up to 10 seconds before reporting the gateway ready.
