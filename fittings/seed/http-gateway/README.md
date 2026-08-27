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
- `POST /jobs` — fire-and-forget scheduled job. A new delivery returns
  `{ ack: true, deduped: false }` (HTTP 202) only after the turn has entered the
  operative queue. A replay backed by retained receipt/card evidence returns
  `{ ack: true, deduped: true, card: string | null }` (HTTP 202). A replay whose
  original generation is still active, dispatching, or undergoing exact-token
  release repair returns retryable HTTP 503 until its outcome is known.
  Primitive bodies or a blank `kind` return HTTP 400; capacity, admission
  failure, or unreadable durable state also returns retryable HTTP 503.

All POST routes serialize through a single in-process `inflight`
Promise chain, so concurrent requests are paired in arrival order
against the underlying Claude session — preserving the FIFO turn
guarantee the channels rely on.

### Scheduled-job dedupe contract

`POST /jobs` derives a stable key from the job `kind` plus a SHA-256 digest of
the complete, recursively key-sorted JSON body. Two byte-order variants of the
same object are therefore one delivery, while a changed date, instruction, or
other payload field is a distinct job.

The first delivery holds an in-process claim until its forwarded turn settles;
active claims never expire underneath a long turn. Pre-dispatch readiness/queue
admission is retried with bounded backoff, and HTTP 202 is not sent until the
queue accepts the turn. An admitted turn is awaited only once: replaying it
after a late failure could duplicate Slack/Trello effects. After it succeeds,
the claim is retained for the card-evidence TTL so a replay cannot slip through
before the new card becomes visible.
The key and canonical payload are atomically persisted below the Kanban root
before HTTP 202 is sent; successful receipts survive a gateway restart for the
same TTL. An active receipt whose process died before dispatch is reclaimable;
a dead `dispatching` receipt is treated as uncertain and retained for the TTL,
because the turn may already have produced external effects.
Concurrent identical requests forward only one generation; contenders receive
retryable HTTP 503 while that generation is active or dispatching, then become
deduped HTTP 202 responses after durable retention. On restart, retained
receipts and active Kanban cards provide durable dedupe evidence: `done`,
`needs-attention`, and abandoned cards never suppress a retry. This is active
work suppression plus at-most-once handling after operative admission, not a
permanent exactly-once ledger; a replay after matching work is terminal is
intentionally eligible to run again.

Card evidence is bounded by a three-hour TTL
(`GARRISON_JOB_DEDUPE_TTL_MS` overrides it with a positive millisecond value).
Freshness uses the newest valid value of `card.created` and `card.updated`, so a
recent update keeps an older run protected. A timestamp-less card is not
positive evidence, but an unreadable directory/card is uncertainty and fails
closed with retryable 503 rather than creating a duplicate. The TTL boundary is exclusive: a
card whose newest timestamp is at least the TTL old no longer suppresses.
Timestamps more than five minutes in the future are not positive dedupe
evidence, so clock corruption cannot disable a schedule indefinitely.

Outstanding in-process claims are capped at 256
(`GARRISON_JOB_DEDUPE_MAX_PENDING` overrides this with a positive integer).
When the cap is reached, the gateway returns a retryable HTTP 503 instead of
accepting and dropping work or evicting an active claim.

The loop-heartbeat and morning-briefing producers retry network errors and 5xx
responses three times with bounded exponential backoff. They do not retry 4xx
payload/configuration failures.

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

The default bind is `127.0.0.1:24777` (set in `apm.yml`). Override
via the `port` and `bind_host` config keys per composition. Channel
Fittings should read the gateway URL from `GATEWAY_URL` (env) and
fall back to `http://127.0.0.1:24777`.

## Execution layer — the warm pool, HOT vs BOOT (s2 / pool-collapse)

The gateway owns **one generic warm operative pool** — never a pool
per `(model × effort × task-type)`. `gateway-routing.mjs` wires exactly
one primary `operative` runtime plus one `classifier` secondary
(`MultiRuntimePool`, FINDING 7). Per-turn variation is applied at
**checkout**, not by partitioning the pool:

- **HOT set** (hot-swappable mid-session, no fresh process) — `{model, effort}`.
  The routed gateway (`gateway-pty.mjs`) slash-injects `/model` and
  `/effort` via `stage-b.mjs` before the turn. This path **never respawns**
  on a model change; it re-tunes the live session in place.
- **BOOT set** (needs a fresh session) — `{system prompt}`. Identity is an
  authored Orchestrator section and is assembled exactly once into that prompt;
  editing it invalidates the warm session before the next turn.
- **Shared memory** ("one operative, one memory") — the Basic Memory faculty
  remains the persistent store. It is not a shared Claude transcript.

**Known gap (no `/config` spike, decided under Q4):** permission-mode,
allowed-tools, and the MCP allowlist are **not** hot-swapped — they would
need `/config key=value` (CC 2.1.181), which this build does not exercise.
Per-turn permission/tool swaps are out of scope and recorded here so the cap is
not silent.

## Verify

The verify hook checks the script file exists. The runner-side
readiness probe in `src/lib/runner.ts` separately polls `/health`
for up to 10 seconds before reporting the gateway ready.
