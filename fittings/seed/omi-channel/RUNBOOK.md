# Omi channel — runbook

Operational reference for the omi-channel fitting. Human setup (Omi app,
keys, funnel) lives in [`HUMAN_SETUP.md`](./HUMAN_SETUP.md); design in
[`docs/adr-omi-channel.md`](./docs/adr-omi-channel.md).

## Where things are

- Server: own-port fitting, port from `GARRISON_OMICHANNEL_PORT`
  (base 7094, prod 8094). Status file
  `$GARRISON_HOME/ui-fittings/omi-channel.json`; log
  `$GARRISON_HOME/ui-fittings/omi-channel.log` (also on
  `/fitting/omi-channel`).
- State: `$GARRISON_HOME/omi/` — `events/` (capture_events), `raw/`
  (preserved payloads; never realtime), `raw-queue/` (pre-normalization),
  `index.json` (dedupe), `state.json` (pinned uid), `threads/`,
  `tips-queue/` + `tips-sent/`, `triage-results/`, `wake-results/`,
  `notify-ledger.json`, `tips-ledger.json`, `backfeed-ledger.json`,
  `counters-*.json`.
- Counters: merged on `GET /health` and the status page (`/`). Key names:
  `events_in`, `dropped_by_rule`, `cards_created`, `wake_hits`,
  `notifications_sent`, `chat_calls`, `backfeed_sent`, plus per-reason
  rejection counters and `wake_hit_to_notification_ms_{last,sum,count}`.
- Scheduler job: `omi-triage` (registered by the server on boot when
  `triage_enabled`; removed when off). Inspect with the scheduler CLI or
  `$GARRISON_HOME/scheduler-jobs.json`.

## Kill switches (I9)

Each pipe has its own boolean in the fitting config (garrison:manage or
the composition manifest), all default OFF:

| flag | pipe | off means |
|---|---|---|
| `enabled` | webhook ingress | every `/omi/*` endpoint answers 403; nothing stored |
| `triage_enabled` | heartbeat triage | scheduler job removed on next restart; ticks exit "disabled" |
| `wake_enabled` | wake bus | realtime segments counted and dropped; mid-capture sessions never dispatch |
| `notify_enabled` | Omi push | outbound degrades to the web-channel thread |
| `chat_enabled` | ask_gary | tool + manifest answer 403 |
| `backfeed_enabled` | import into Omi | no interval scheduled |
| `tips_enabled` | tips | triage emits no tips |

Config changes apply at the next `up` (env-fingerprint heal) or
immediately via `POST /api/fittings/omi-channel/restart`.

## The two model lanes (why spoken commands are fast now)

Every model call this fitting makes goes to the gateway's `/chat`, but they are
not the same kind of work and must not share a lane:

- **Classification** (wake intent, wake revision, batch triage, the fast half of
  `ask_gary`) is pinned to `classify_target` (default `cc-haiku-low`). Unpinned,
  these resolve to the composition's `other`/L1 duty cell - a full Sonnet
  agent-sdk turn carrying the operative's whole toolset. Measured: **82s** for
  one classification, against a wearer waiting to hear back and an `ask_gary`
  budget of 8.5s. Pinned: ~6s.
- **Delegation** (`delegate_enabled`) is the opposite: the real operative with
  its tools and connectors, no pin, a ten-minute budget. Nothing blocks on it -
  the wearer gets an acknowledgement first and the answer arrives as a second
  notification. This is the ONLY path from speech to an integration; the
  classifier lane cannot send a message or read the board, it can only answer
  from its own head.

Latency of a spoken command splits into `wake_capture_ms` (waiting to be sure
the user stopped talking) + `wake_classify_ms` + `wake_notify_ms`. Read them
separately on `/health` - a single end-to-end number cannot say which regressed,
and guessing from the total already produced one wrong diagnosis. Typical today:
5s + 6s + 0.4s ≈ 12s to the acknowledgement, plus the operative's own time
(7-90s) when the command was delegated.

`wake_settled_close_ms` (5s) is why capture is no longer the dominant cost: a
segment ending in `.`, `?` or `!` closes the window early, while anything
unpunctuated still waits the full `wake_silence_close_ms`.

## Driving the whole thing end to end (`scripts/speak.mjs`)

```bash
# a spoken command, injected at the realtime webhook exactly as Omi delivers it
node scripts/speak.mjs say "Gary, cria uma tarefa para comprar peixe."
node scripts/speak.mjs say "Gary, what is on my board?" --garble --wait 300

# a conversation, injected THROUGH the Omi cloud - Omi structures it and calls
# our webhook back, so this is the only mode that exercises Omi's own pipeline
node scripts/speak.mjs converse "I decided we ship Friday. Remind me to call the bank."

# the Omi chat tool, called exactly as Omi calls it
node scripts/speak.mjs ask "which cards are in progress?"
```

Each mode follows its own effect and prints it (the assembled command, the
intent, the card, the delegated answer, the triage verdict) or says plainly that
nothing arrived. `--garble` interleaves real background speech from this
account's own captures - television, family, transcriber filler - which is the
signal-to-noise ratio the wake bus actually faces.

**What it does not cover:** Omi exposes no inbound audio API, so `say` starts at
the transcript, not at sound. Omi's own speech-to-text is therefore never under
test - and on this account it is the weakest link in the chain (see "Transcript
quality" below). `converse` is the only mode where Omi's own processing runs.

## Transcript quality (measure it before blaming it)

Omi's own titles make capture look worse than it is - "Garbled Conversation",
"Fragmented Multilingual Conversation", "Repeated Phrase Exchange" are
day-to-day sights, and it is tempting to conclude transcription is broken.
Measured over the last 16 stored conversations on this account, **13 are clean
Portuguese**. The failures are not systemic and not a language misconfiguration:
they are **degenerate decoder output on low-speech or noisy stretches**, where
the model loops one phrase - once producing 126 words of Dutch ("En hou het
voor de massa" over and over) on a conversation correctly tagged `language:
pt`, with a healthy 754-word Portuguese capture three minutes later.

So: a single garbled conversation is not evidence of a broken setup. Sample
before concluding, over what Omi actually delivered rather than the API's
conversation list (which returns `transcript_segments: null`):

```bash
# language-sniff the transcripts we stored from the webhook
python3 - <<'PY'
import json, glob, re
PT = set("que não uma para com você está isso então mas muito bem aqui vamos porque".split())
for f in sorted(glob.glob('/home/ggomes/.garrison/omi/events/*.json')):
    d = json.load(open(f))
    t = ((d.get('normalized') or {}).get('transcript_text') or '')
    w = re.findall(r"[a-zà-ÿ]+", t.lower())
    if len(w) < 25: continue
    print(d['occurred_at'][:16], f"pt={sum(x in PT for x in w)/len(w):.3f}", len(w), "words")
PY
```

A pt score around 0.07-0.17 is a healthy Portuguese transcript; near 0.00 with a
low word count is a degenerate stretch.

Transcription language is a **per-connection query parameter the phone app
sets** (`language`, default `en`, `multi` = auto-detect) on Omi's `/v4/listen`
socket - there is no server-side user setting and no API to change it. Stored
conversations carry the value that was used, so `language` on a conversation
tells you what the app declared: this account shows `multi` on 2026-08-07 and
`pt` since. Providers "fail closed" on an unsupported language rather than
falling back.

## Replaying fixtures

```bash
node scripts/replay.mjs --base http://127.0.0.1:7094 \
  --key "$OMI_WEBHOOK_SECRET" --uid <pinned-uid> --twice
```

Replaying any set twice is a no-op by design (fingerprint + semantic
dedupe). To reprocess an event, set its `status` back to `"pending"` in
`events/<id>.json`; to fully re-ingest a payload, also remove its
fingerprint from `index.json`.

## Failure modes

- **Webhooks rejected 401/403** — wrong `?key=` (rotate below), foreign
  uid (see pinned uid below), or `enabled` off. Check the per-reason
  counters on `/health`.
- **Events stuck `pending`** — triage skipped: check the tick output in
  the scheduler log (`$GARRISON_HOME/scheduler.log`). Reasons are logged:
  gateway URL missing, board unreachable (start the composition), or
  transport errors (gateway restarting — retries next tick, nothing
  lost). Run one tick by hand:
  `node scripts/triage.mjs --tick` (needs `GARRISON_GATEWAY_URL` and
  `GARRISON_OMICHANNEL_TRIAGE_ENABLED=true` in env).
- **Events `failed`** — malformed payloads keep raw in `raw/` for
  inspection; triage batches park as failed after 5 unparseable-reply
  attempts (see `failure_reason` on the event).
- **No notifications on the wearer** — `/health` secrets block shows
  which vault keys are missing; a 401 from the Omi API logs loudly
  (check `OMI_APP_ID`/`OMI_APP_SECRET`); the daily cap
  (`notify_max_per_day`) degrades delivery to the web-channel thread —
  receipts are in the server log (`notify <template> -> ...`).
- **Wake word not triggering** — `wake_enabled` on? `wake_hits` vs
  `wake_segments_dropped` on /health tells you whether segments arrive at
  all (Omi realtime webhook configured?) vs the gate not matching (check
  `wake_variants` spelling against what the transcript actually writes —
  transcripts are PT/EN mixed).
- **Wake triggers but nothing happens** — `wake_empty_commands` (spoke
  the wake word alone), `wake_killed_mid_session`, or dispatch degraded
  to a note (see `wake-results/<id>.json` for the reason; the wearer got
  an honest confirmation either way).
- **ask_gary slow/unanswered** — overruns return a friendly answer and
  count `chat_overruns`; the operative's serialized turn chain is the
  usual cause (a long card run in flight).
- **Backfeed silent** — flag off, `OMI_IMPORT_API_KEY` missing
  (`backfeed_skipped_unconfigured`), or a non-retriable API failure
  stopped the run (logged; nothing ledgered, so it resends once fixed).
  Manual run: `node scripts/backfeed.mjs --run`.
- **Server refuses to start** — a live pid holds the status file (stop it
  first) or the canonical port is taken (never falls back to a shifted
  port).

## Key rotation

All secrets live in the Vault (`/vault`), delivered at spawn; rotate by
updating the vault value then `POST /api/fittings/omi-channel/restart`.

- `OMI_WEBHOOK_SECRET` (our shared secret): generate a new random value,
  update the vault, restart the fitting, then update every URL that
  embeds it — the four webhook URLs in Omi Developer Settings and the
  Chat Tools Manifest URL (HUMAN_SETUP.md has the click-paths). Rotating
  invalidates old URLs immediately (counted as `rejected_auth`).
- `OMI_APP_SECRET` (notifications): regenerate in the Omi developer
  portal for the app, update the vault, restart.
- `OMI_IMPORT_API_KEY` (`sk_...`): app management page -> API Keys ->
  create a new key, update the vault, restart, delete the old key.

## Pinned uid

The first authenticated webhook call pins its uid
(`$GARRISON_HOME/omi/state.json`); everything else is rejected (I8). To
re-pin (new Omi account), stop the fitting, delete `state.json`, start,
and let the right device call first.

## Public ingress (funnel)

`node scripts/funnel-ensure.mjs` on the PROD shell mounts ONLY the `/omi`
path prefix at `https://<node>:8443` (idempotent; refuses non-prod;
never :443). Verify with `tailscale funnel status`. To tear public
ingress down: `tailscale funnel --https=8443 off`.

## Testing hooks

`OMI_API_BASE_URL` redirects the Omi cloud client (notifications +
import) to a stub — used by `tests/omi-channel-e2e.test.ts`, handy
against a local mock. All suites:
`npm test -- tests/omi-channel*.test.ts` (server tests sandbox
`GARRISON_HOME`; safe alongside a live instance).
