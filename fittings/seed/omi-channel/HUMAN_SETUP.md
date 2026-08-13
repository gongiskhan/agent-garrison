# Omi channel — human setup checklist

Everything the fitting cannot do for itself: Omi accounts, apps, keys,
device installs, and the public ingress. Work top to bottom; each step
says how to verify it. Click-paths verified against docs.omi.me on
2026-07-30 (see `docs/omi-api-notes.md`) — if the Omi app UI has moved,
the docs index at https://docs.omi.me/llms.txt is the source of truth.

## 0. Subscription reality check

Omi's free tier is roughly 1,200 listening minutes per month — that is
~40 min/day and will NOT survive always-on capture. Plan for the paid
tier before relying on the batch pipe (check current pricing in the Omi
app under subscription settings). Day summaries additionally require the
Omi app to hold a push token (notifications enabled on the phone) and a
configured timezone, or Omi's cron skips you silently.

## 1. Devices

- **iPhone**: install the Omi app (App Store), sign in, enable
  notifications (required for day summaries AND for our outbound pipe).
- **Mac desktop app**: install from omi.me; grant mic + system audio +
  screen permissions as prompted. Sign into the SAME account.
- **Apple Watch**: install the Omi watch app from the paired iPhone
  (wrist trigger).
- **Pendant (later)**: pair via the iPhone app when it arrives.

One account everywhere — the channel pins a single uid (I8).

## 2. Vault secrets (Garrison /vault)

Seal these four (exact names; the fitting's /health page shows which are
missing):

| key | what | where it comes from |
|---|---|---|
| `OMI_WEBHOOK_SECRET` | our shared secret in every inbound URL | generate yourself: `openssl rand -hex 24` |
| `OMI_APP_ID` | the private Omi app's id | app management page (step 4) |
| `OMI_APP_SECRET` | Bearer for direct notifications | app management page (step 4) |
| `OMI_IMPORT_API_KEY` | `sk_...` Bearer for the Import API (backfeed) | app management page -> API Keys (step 4) |

## 3. Public ingress (prod box)

Omi's cloud must reach the fitting over public HTTPS.

1. Start the composition (`up`) so the fitting is running and its status
   file has the live prod port.
2. On the PROD shell:
   `node <checkout>/fittings/seed/omi-channel/scripts/funnel-ensure.mjs`
   - mounts ONLY `/omi` at `https://dev-madrid.tail31efa.ts.net:8443`;
   - refuses to run from a non-prod shell; never touches :443.
3. Verify: `tailscale funnel status` shows the 8443 -> /omi mapping, and
   from any network (phone on cellular):
   `curl https://dev-madrid.tail31efa.ts.net:8443/omi/memory` returns
   HTTP 4xx JSON (403 while the flag is off; 401 without the key) — NOT
   a timeout.
4. Set the fitting config `public_base_url` to
   `https://dev-madrid.tail31efa.ts.net:8443` (garrison:manage), restart
   the fitting.

Your webhook base is then:
`https://dev-madrid.tail31efa.ts.net:8443/omi/<endpoint>?key=<OMI_WEBHOOK_SECRET>&uid=` —
Omi appends the uid itself on webhook deliveries.

## 4. The private Omi app (notifications + chat tool + import)

In the Omi iPhone app:

1. **Explore -> Create an App**. Name it (e.g. "Garrison"), private —
   do NOT submit to the store (this stays a private app).
2. Enable the **External Integration** capability.
   - Webhook URL: not needed here if you use Developer Mode webhooks
     (step 5) — but the capability must be on for chat tools and import.
   - App Home URL: `https://dev-madrid.tail31efa.ts.net:8443`
   - **Chat Tools Manifest URL**:
     `https://dev-madrid.tail31efa.ts.net:8443/omi/tools-manifest?key=<OMI_WEBHOOK_SECRET>`
     (re-save the app whenever the manifest changes — Omi caches it).
   - Under Imports, enable creating **memories**.
3. Install the app in your own account and enable it (Import calls fail
   403 until the user has the app enabled).
4. Collect credentials:
   - **App ID** and **App Secret**: the app's management page (docs:
     "your App ID and App Secret from the Omi developer portal") ->
     vault `OMI_APP_ID` / `OMI_APP_SECRET`.
   - **API Keys -> Create Key** (shown once) -> vault
     `OMI_IMPORT_API_KEY`.
5. Restart the fitting after sealing
   (`POST /api/fittings/omi-channel/restart` or a composition
   down/up). `/health` must show all four secrets `sealed: true`.

## 5. Developer Mode webhooks (the ingress pipes)

Omi app -> **Settings -> enable Developer Mode -> Developer Settings**.
Fill the four webhook fields (all carry our key; Omi adds `uid` /
`session_id` itself):

| field | URL |
|---|---|
| Memory Creation Webhook | `https://dev-madrid.tail31efa.ts.net:8443/omi/memory?key=<SECRET>` |
| Real-Time Transcript Webhook | `https://dev-madrid.tail31efa.ts.net:8443/omi/realtime?key=<SECRET>` |
| Day Summary Webhook | `https://dev-madrid.tail31efa.ts.net:8443/omi/day-summary?key=<SECRET>` |
| Audio Bytes Webhook | leave empty (out of scope) |

## 6. Turn the pipes on

In Garrison (garrison:manage for omi-channel), flip in this order,
verifying each:

1. `enabled` (ingress) — in the Omi app open any memory -> 3-dot menu ->
   Developer Tools -> **"Trigger webhook with existing data"**. Then
   check `/health`: `events_in` incremented and the pinned uid appears.
   THIS FIRST CALL PINS YOUR UID — make sure it comes from your device,
   not a test curl with a fake uid.
2. `notify_enabled` — from the box:
   `curl -X POST "https://api.omi.me/v2/integrations/$OMI_APP_ID/notification?uid=<your-uid>&message=hello+from+garrison" -H "Authorization: Bearer $OMI_APP_SECRET"`
   -> push arrives on the phone (and Watch, if mirrored).
3. `triage_enabled` — speak a conversation with a clear action item, wait
   for Omi to close the memory (or trigger the webhook manually), then
   wait one triage tick (default 5 min): a card appears in the Kanban
   backlog with `origin: omi` and a `card_created` push arrives.
4. `wake_enabled` — the spoken smoke test below.
5. `chat_enabled` — in Omi chat, type: "ask Zeca how my board looks".
   Omi should call `ask_zeca` and answer with Garrison's reply within
   ~10s. If Omi's model doesn't pick the tool, re-save the app (manifest
   refresh) and phrase with "Zeca".
6. `backfeed_enabled` (+ optionally add `daily_digest` to
   `backfeed_kinds`) — complete a card, wait <=30 min (or run
   `node scripts/backfeed.mjs --run`), then in the Omi app check
   Memories for "Garrison completed: ...".
7. `tips_enabled` — optional; capped by `tips_max_per_day`.

## 7. Spoken smoke test

Wearing/near the mic, say:

> "Zeca, create a test task called hello garrison."

Expected, in order:

1. Within a few seconds of you pausing (silence window 4s): phone push
   "Card created: ..." with a card link (total expected
   wake-to-notification: 5-20s depending on the realtime webhook lag —
   the actual number lands in `wake_hit_to_notification_ms_last` on
   /health).
2. The card sits in the Kanban backlog, `origin: omi`,
   `origin_id: omi:wake:...`, with the spoken command quoted as source
   context.
3. `/health`: `wake_hits: 1`, `wake_dispatches: 1`.

Negative checks - none of these may push or card, and each should only
increment `wake_segments_dropped`:

- "the garrison deploy is fine" - near-miss, no wake token at all.
- "o Zeca ligou ontem" / "I'll send Zeca the invoice" - the name is
  MENTIONED, not addressed. This is the case the wake gate tightened for:
  "Zeca" is an ordinary Portuguese given name, so it only wakes when it
  opens the utterance or a clause, or follows a short vocative lead-in
  ("hey Zeca", "ok Zeca do it", "não Zeca, quarta-feira").

## 8. Day summary caveat

The day-summary webhook fires ONLY from Omi's hourly cron at your
configured notification hour — the in-app "Generate Summary" button does
NOT call webhooks. To validate quickly: set the delivery hour to the next
upcoming hour and wait. No conversations that day / no push token / no
timezone = no delivery (that is "no recap", not a failure).

## 9. What to watch after go-live (spec open questions)

Record real numbers for: realtime webhook latency/variance
(`wake_hit_to_notification_ms_*`), direct-notification rate limits and
Watch delivery behavior, whether Omi's model calls `ask_zeca` reliably or
paraphrases its results, whether notification replies are read aloud, and
the actual free-tier burn rate under always-on.

## 10. REQUIRED after the Gary -> Zeca rename (2026-08-13)

The operative was renamed. Everything in this repo already says Zeca, but
**two things live on Omi's servers and can only be changed from the phone**.
Until you do them, the chat tool silently keeps failing:

1. **Re-save the private Omi app** (Explore -> your app -> Save), with no
   field edited. The chat tool was renamed `ask_gary` -> `ask_zeca`, and
   **Omi caches the Chat Tools Manifest**. Until the app is re-saved, Omi
   keeps calling the tool by its old name against a server that no longer
   serves it. This is the same cache that once made a rotated key 401 every
   call for a day.
2. **Re-phrase your chat probe.** In Omi chat, "ask Zeca how my board looks"
   should now call `ask_zeca`. If Omi's model still doesn't pick the tool
   after a re-save, wait a minute and try once more - the manifest refresh is
   not instant.

Nothing else on the Omi side changes: App ID, App Secret, Import key, the
manifest URL and all four Developer-Mode webhook URLs are untouched, because
no route or secret was renamed.

Then re-run the §7 spoken smoke test with the new wake word:

> "Zeca, create a test task called hello garrison."

If the wake word does not fire, check `/health` -> the fitting logs a line at
startup when it finds a `wake_variants` config left over from the old name and
ignores it. You do not need to edit that key; clearing it just silences the log.
