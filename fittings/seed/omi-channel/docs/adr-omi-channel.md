# ADR: Omi channel placement (M0)

Date: 2026-07-30. Status: accepted. Scope: where each piece of the Omi
channel lives in Garrison, per the implementation spec's M0 recon
requirement. Deviations from the spec are mirrored one-line-each in
[`../DECISIONS.md`](../DECISIONS.md).

## Shape

`omi-channel` is an own-port channel fitting (`faculty: channels`,
`provides: [{kind: channel, name: omi}]`, `own_port: true`,
`default_port: 7094` base family / 8094 prod). Own-port is the only
lifecycle that gets a long-running process (webhook ingress, wake-word
session timers, scheduler-registered triage) spawned, healed, and stopped
with the operative; the slack-channel adapter's `component_shape: script`
without `own_port` is precisely why it never runs. The runner projects
`GARRISON_OMICHANNEL_PORT`, `GARRISON_OMICHANNEL_<KEY>` config,
`GARRISON_GATEWAY_URL`, `GARRISON_BASE_URL`, `GARRISON_COMPOSITION_ID/DIR`,
and the `secret_scope` vault keys (`OMI_APP_ID`, `OMI_APP_SECRET`,
`OMI_IMPORT_API_KEY`, `OMI_WEBHOOK_SECRET`) into the spawn env. All feature
flags are `config_schema` booleans defaulting false (off = byte-identical,
inert server).

## Ingress: Tailscale Funnel on port 8443 (decided)

Omi's cloud must POST to us over public HTTPS. Recon findings (2026-07-30):

- Zero public ingress exists today; all 19 `tailscale serve` mappings are
  tailnet-only.
- The node's tailnet policy ALREADY grants Funnel on ports 443/8443/10000
  (`Self.CapMap` carries `funnel-ports?ports=443,8443,10000`), certs are
  provisioned, and `scripts/tailnet-serve-views.mjs` `pickServePort()`
  deliberately skips 8443 so nothing can collide.
- The GCP public-IP path (34.175.99.35) would need a new firewall rule, a
  0.0.0.0 bind (explicitly reversed 2026-07-27 after the cleartext-vault
  leak), and a TLS terminator that is not installed. Rejected.
- No tunnel binary (cloudflared/ngrok) is installed; ephemeral URLs would
  break Omi's stored webhook config anyway. Rejected.
- The Mac Mini is behind Tailscale and is not the ingress (spec).

Decision: `tailscale funnel --bg --https=8443` proxying ONLY the `/omi`
path prefix to the prod omi-channel loopback port. Public URL shape:
`https://dev-madrid.tail31efa.ts.net:8443/omi/...`. Every ingress route on
the server therefore lives under `/omi/`; `/health` and the status page
stay off the funnel mount. Never funnel :443 (that would expose the whole
prod Garrison app), never a dev 7xxx port; the funnel-ensure step is
prod-guarded like `tailnet-serve-views.mjs`. Enabling the funnel is a
HUMAN_SETUP step (M7), not done by this task; with the `enabled` flag off
the endpoints answer 403 regardless.

Webhook auth (Omi webhooks are unsigned): every `/omi/*` request must carry
`?key=<OMI_WEBHOOK_SECRET>` compared with `crypto.timingSafeEqual`, plus
the uid allowlist (single uid pinned on first authenticated call). Wrong
key or foreign uid: rejected and counted, body untouched (I8).

## Inbox storage: fitting-local file store (decided)

`$GARRISON_HOME/omi/` (override `GARRISON_OMI_DIR`), kanban-loop's
conventions: file-per-record `events/<ulid>.json` for `capture_event`s,
`raw/<ulid>.json` for raw payload refs, `state.json` (pinned uid),
`counters.json`, `backfeed-ledger.json`; every write atomic
temp-then-rename. Rejected: the artifact/document store (user-facing
artifacts, not high-churn machine state) and a DB (nothing else in the
repo uses one). `GARRISON_HOME` is honored so sandboxed tests never touch
live state.

## Heartbeat hook: own scheduler job, not a kanban-loop patch (decided)

The "Kanban Loop heartbeat" is concretely the scheduler fitting's cron
daemon (`~/.garrison/scheduler-jobs.json`, health :7099/:8099) running the
`kanban-tick` job every 2 minutes; kanban-loop's own guidance (and
`registerTick()`/`syncListBeat` precedent) is that a new consumer registers
its OWN job rather than editing `tick()`. Decision: the omi server
registers job id `omi-triage` (default `*/5 * * * *`, config
`triage_cron`) on boot when `triage_enabled` is on — boot-time registration
copies kanban's own pattern (the server has `GARRISON_GATEWAY_URL` in
scope; setup hooks must not require the scheduler). The job runs
`node scripts/triage.mjs --tick` with instance env baked into the command
(`instanceEnvPrefix` pattern; the dev-port-literal-in-prod-job failure mode
is documented in the repo memory). Same heartbeat engine, own job id, zero
kanban-loop code changes, independently killable (I9).

Cards are created through the board's public API — `POST /cards` with
`origin: "omi"`, `origin_id: "omi:<conversation-id>[:n]"` (the natural
dedupe key; the board itself has NO dedupe), base URL resolved at call time
from `~/.garrison/ui-fittings/kanban-loop.json` (`boardBase()` pattern;
board down = queue and retry, never hard-block). Cards land in backlog for
human promotion. `project` is a LABEL: pass a bare dev-root slug when triage
is confident, else omit and let the board's project inference run.

## Orchestrator interface: the http-gateway HTTP surface (decided)

Everything model-shaped goes through `GARRISON_GATEWAY_URL` (runner-
projected; no literal port fallback — unresolvable gateway means the pipe
skips with a logged reason):

- **Triage batch call (M2)**: the kanban `inferenceRunFn` pattern —
  blocking `POST /chat`, headers `x-garrison-origin: channel`, body
  `{channel: "omi", message: <one prompt over the whole batch>,
  classification: {taskType: "other", tier: "T0-trivial"},
  suppressContinuations: true}`, tight AbortController. `"other"` is not
  task-shaped so the turn never becomes a card; T0-trivial routes cheap.
  The ~40-line client is copied into `lib/gateway-client.mjs`, not imported
  across fittings (containment convention), keeping the `err.transport`
  classification so a gateway restart requeues instead of dropping.
- **Wake commands (M4)**: fitting-side intent parse, then per intent:
  create_task → board `POST /cards` (I4: tasks have one home) +
  confirmation with deep link; note → memory write; query → bounded
  blocking `/chat` answer pushed back as a notification; create_event /
  fallthrough → a turn on channel "omi" (D19 auto-carding applies to
  task-shaped turns, which is correct for "Zeca, go do X").
- **ask_zeca (M5)**: blocking `POST /chat` with the T0-trivial hint,
  `suppressContinuations: true`, and a client AbortController at ~9s (the
  agent-sdk lane ignores `timeoutMs`; the turn chain is serialized, so a
  busy operative degrades to a friendly "Zeca is mid-task" partial answer).
  `garrison-call` is rejected for ask_zeca: no memory, no skills, no
  orchestrator context — it would violate the single-brain spirit.

## Outbound: in-fitting Omi client + the two real notification seams (decided)

There is no notifications fitting and no web push in the repo (zero VAPID/
PushManager; the Capacitor memo defers real push). What exists: drill's
`broadcastOutcome()` fan-out discipline and kanban's `CHANNEL_FITTINGS`
registry (`lib/notify-origin.mjs`), whose own comment names adding a map
entry as THE opt-in for card lifecycle notifications. Decision:

- `lib/notify.mjs` in this fitting sends Omi **direct** notifications
  (`POST https://api.omi.me/v2/integrations/{OMI_APP_ID}/notification` with
  `?uid&message` query params, `Authorization: Bearer OMI_APP_SECRET`) —
  the verified API takes exactly `uid` + `message`; there is no title/body
  JSON. 401 fails with reason; 429/5xx retry with backoff; per-day cap from
  config. Message text is always Garrison-rendered (I1); plain text + one
  deep link, no action buttons (house principle: the detail lives behind
  the links).
- Fallback "PWA push" = the web-channel PWA thread-append contract
  (`POST <web-channel>/api/threads/:id/messages`), the repo's actual
  mobile-reachable surface. Used when `notify_enabled` is off, secrets are
  missing, the cap is hit, or the Omi API fails (I9 degrade path).
- The omi server exposes the same thread-append contract
  (`POST /api/threads`, `POST /api/threads/:id/messages`) so
  `CHANNEL_FITTINGS` in kanban's notify-origin gains `omi: "omi-channel"`
  (M3; the one-line registration those files invite). That entry is the
  "listens to system notifications" toggle equivalent — the spec's named
  toggle does not exist in the repo.
- Deep links are built server-side with the loopback+tailnet pairing
  (`tailnetUrlForPort` pattern) — the tapping phone is never on this box;
  a 127.0.0.1 URL must never reach Omi.

## Backfeed: Import API with a client-side fingerprint ledger (decided)

`POST https://api.omi.me/v2/integrations/{app_id}/user/memories?uid=` with
`Bearer OMI_IMPORT_API_KEY` (per-app `sk_` key — a DIFFERENT credential
from the notification App Secret). The verified docs show NO server-side
dedupe and no returned ids, so idempotency is entirely ours:
`backfeed-ledger.json` keyed by content fingerprint (I6). Flag-gated off.

## Memory writes: basic-memory vault files (decided)

Triage memory candidates are written headlessly as frontmattered markdown
into `$BASIC_MEMORY_VAULT_DIR` (default `~/ObsidianVault`) +
`$BASIC_MEMORY_MEMORY_DIR` (default `Memory`), the `capture-session.py`
pattern: `title/type/tags` frontmatter (tag `omi`), provenance bullets
(when / omi conversation id / category), secret redaction, filename prefix
`omi-<ts>.md` — NOT `session-*`, which the improver dream phase treats as
expendable checkpoints. The fitting declares
`consumes: [{kind: memory-store, cardinality: optional-one}]`. Never write
MEMORY.md programmatically; never mutate existing vault notes.

## Observability

Plain `console.log`/`console.error` with the `[omi-channel]` prefix (the
own-port lifecycle already routes stdout to
`~/.garrison/ui-fittings/omi-channel.log`, surfaced at
`/fitting/omi-channel`). Counters live in `$GARRISON_HOME/omi/counters.json`
and are exposed on `GET /health` + the status page — zero new Garrison UI.
Wake-bus logs and counters carry no transcript content (I5).

## Out of scope / rejected

- `provides: connector` + the `/api/connectors/omi/auth-env` seam: our own
  server already holds the scoped secrets in its spawn env; nothing else
  needs Omi credentials. Revisit only if an external process must send.
- Realtime **audio-bytes** trigger (discovered in docs, not in spec): out
  of scope, wake bus uses the transcript trigger.
- Omi proactive notifications, marketplace submission, desktop fork,
  self-hosting: parked per spec §8.
