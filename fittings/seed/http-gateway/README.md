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
- **BOOT set** (needs a fresh session) — `{system prompt / soul identity}`.
  In the dormant orchestrator/soul mode (`gateway.mjs`, activated by
  `GARRISON_SOULS_CONFIG`) each face (gary/joe/james) is a **separate soul
  session** keyed in the registry; within a soul, `shouldRespawnForTier`
  respawns-with-resume on a model change so the conversation id (and thus
  context) is preserved. **These are two distinct paths** — the routed
  gateway keeps model HOT; only the soul mode respawns, and only to carry a
  BOOT-level change across a fresh process. A mode switch is realized by
  routing to a different soul session, not by re-keying the pool.
- **Shared memory** ("one operative, one memory") — the Basic Memory faculty
  (the vault) is shared across all three faces by construction: every soul
  session reads and writes the same store. This is the persistent memory
  store, not a shared Claude transcript.

**Known gap (no `/config` spike, decided under Q4):** permission-mode,
allowed-tools, and the MCP allowlist are **not** hot-swapped — they would
need `/config key=value` (CC 2.1.181), which this build does not exercise.
Identity/mode switches rely on respawn (safe); per-turn permission/tool
swaps are out of scope and recorded here so the cap is not silent.

## Verify

The verify hook checks the script file exists. The runner-side
readiness probe in `src/lib/runner.ts` separately polls `/health`
for up to 10 seconds before reporting the gateway ready.
