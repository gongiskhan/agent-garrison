# Omi API notes (verified against docs.omi.me, 2026-07-30)

Recorded per the build spec: docs beat the spec; every difference is logged
here and mirrored in ../DECISIONS.md. Re-verify before each client
implementation milestone (raw markdown of any page: <url>.md; full index:
https://docs.omi.me/llms.txt; bulk: llms-full.txt).


---

# https://docs.omi.me/doc/developer/apps/Integrations
fetched: true

# Omi Integration Apps (docs.omi.me/doc/developer/apps/Integrations)

Verified 2026-07-30 against the live page, cross-checked via the raw Mintlify markdown (`https://docs.omi.me/doc/developer/apps/Integrations.md`) and a rendered-page fetch. Both sources agree.

## Verdict vs our spec

- **REFUTED (one field name):** In the **memory-creation** trigger payload, the transcript segment field is **`speakerId` (camelCase), not `speaker_id`**. Our spec said `speaker_id` for memory triggers; the doc uses `speakerId` in BOTH the memory trigger and the realtime transcript payloads. All other memory-payload fields match the spec exactly.
- **CONFIRMED:** Realtime transcript payload shape and query params match the spec exactly (`{text, speaker, speakerId, is_user, start, end}` array, `?session_id=&uid=`, delivered across multiple calls).
- **CONFIRMED but our spec is incomplete:** Day summary payload. Everything in the spec is present, but the doc adds a legacy top-level `summary` string field, plus `id`, `date`, `created_at`, `day_emoji` inside `summary_json`, concrete `stats` keys, and concrete item shapes for highlights/unresolved_questions/decisions_made/knowledge_nuggets/locations. It also documents hard delivery conditions (FCM token prerequisite, Redis dedup lock, timezone requirement) our spec omits.
- **CONFIRMED with a caveat:** Developer-mode webhook setup exists for all four triggers; delivery-frequency config exists but applies ONLY to the audio-bytes trigger (`url,seconds`). The Day Summary webhook **cannot** be manually triggered from the app — cron path only.
- **Not in our spec:** a fourth trigger type, **Real-Time Audio Bytes** (raw PCM16 stream), documented below.

## Overview

Integration apps are webhook-based: Omi POSTs data to your server. Four trigger types: Memory Creation, Real-Time Transcript, Real-Time Audio Bytes, Day Summary. Unlike prompt-based apps, you must host a server.

## Auth mechanism

- Webhook deliveries themselves carry **no auth** — user identity arrives as the `uid` query parameter on every POST.
- Optional app-submission fields for your own auth: an **Auth URL** (user authentication; Omi appends `uid` automatically) and a **Setup Completed URL** (GET endpoint returning `{"is_setup_completed": boolean}`). When users open your setup links, Omi automatically appends a `uid` query parameter — use it to associate credentials with specific users.
- No signing secret, bearer token, or HMAC is mentioned anywhere on the page.

## Rate limits

None documented on this page. The only frequency control mentioned is the audio-bytes `url,seconds` delivery-interval setting, and the day summary's at-most-once-per-day guarantee.

---

## 1. Memory Creation Triggers

Fires when Omi creates a new memory (conversation completed and processed). Webhook receives the full conversation: transcript, structured summary, action items, metadata.

**Request:** `POST /your-endpoint?uid=user123` (JSON body)

Verbatim payload example from the doc:

```json
{
  "id": "memory_abc123",
  "created_at": "2024-07-22T23:59:45.910559+00:00",
  "started_at": "2024-07-21T22:34:43.384323+00:00",
  "finished_at": "2024-07-21T22:35:43.384323+00:00",
  "transcript_segments": [
    {
      "text": "Let's discuss the project timeline.",
      "speaker": "SPEAKER_00",
      "speakerId": 0,
      "speaker_name": "John",
      "is_user": false,
      "start": 10.0,
      "end": 15.0
    }
  ],
  "structured": {
    "title": "Project Timeline Discussion",
    "overview": "Brief overview of the conversation...",
    "emoji": "📅",
    "category": "work",
    "action_items": [
      {
        "description": "Send project proposal by Friday",
        "completed": false
      }
    ],
    "events": []
  },
  "apps_response": [],
  "discarded": false,
  "folder_id": "folder_uuid",
  "folder_name": "Work"
}
```

Field notes:
- Timestamps: ISO 8601 with explicit `+00:00` offset.
- `transcript_segments[].speakerId` is a number (0-based); `speaker` is the diarization label string (`SPEAKER_00`); `speaker_name` may be present (memory trigger only — the realtime payload has no `speaker_name`); `start`/`end` are seconds (floats).
- Mixed naming inside one segment object: `speakerId` (camel) alongside `speaker_name`/`is_user` (snake). Model it exactly as shown.
- `structured.action_items[]`: `{description: string, completed: boolean}`. `structured.events`: array (shown empty; shape not documented here).
- `apps_response`: array (shown empty; item shape not documented here). `discarded`: boolean. `folder_id`/`folder_name`: strings.

Reference implementation linked from the doc: `https://github.com/BasedHardware/Omi/blob/main/plugins/oauth/conversation_created.py` (Notion CRM example).

## 2. Real-Time Transcript Processors

Segments arrive **in multiple calls** as the conversation unfolds.

**Request:** `POST /your-endpoint?session_id=abc123&uid=user123` (JSON body = a bare array)

Verbatim payload example:

```json
[
  {
    "text": "I think we should prioritize the mobile app.",
    "speaker": "SPEAKER_00",
    "speakerId": 0,
    "is_user": false,
    "start": 10.0,
    "end": 15.0
  },
  {
    "text": "Agreed, let's start with iOS.",
    "speaker": "SPEAKER_01",
    "speakerId": 1,
    "is_user": true,
    "start": 16.0,
    "end": 18.0
  }
]
```

Implementation guidance from the doc: track context across calls via `session_id`; implement dedup (the same segments can arrive more than once); accumulate segments to build full context; fail gracefully and return fast — don't block transcription with slow processing.

## 3. Real-Time Audio Bytes (not in our spec — new)

Raw audio stream instead of text.

| Setting | Value |
| --- | --- |
| Trigger Type | `audio_bytes` |
| HTTP Method | POST |
| Content-Type | `application/octet-stream` |
| Audio Format | PCM16 (16-bit little-endian) |
| Bytes per Sample | 2 |

**Request:** `POST /your-endpoint?sample_rate=16000&uid=user123` — body is raw PCM16 bytes. To make a playable WAV, prepend a WAV header and concatenate chunks.

**Delivery frequency** is configured in the Omi app Developer Settings as `url,seconds` — e.g. `https://your-endpoint.com/audio,5` sends audio every 5 seconds. (This frequency knob applies to audio bytes only.) Full guide: `/doc/developer/apps/AudioStreaming`.

## 4. Day Summary

Delivered **at most once per day**, at the user's configured notification hour. An hourly cron runs at minute 0 of every UTC hour; users whose local time matches their configured hour get an LLM-generated summary.

- **Day selection:** if the user's local time is before noon, the summary covers the *previous* day; at noon or later, *today*.
- **Timezone requirement:** the cron selects recipients by configured timezone; users without a timezone are skipped by the schedule. (The manual "Generate Summary" trigger falls back to UTC day boundaries and works without a timezone — but see the testing caveat below.)
- **The webhook does NOT fire when:** the user has no conversations for the selected day; all conversations are locked or have no transcribed speech; the user has **no FCM push token** registered (the cron filters token-less users out, and the manual endpoint returns HTTP 400 — push delivery is currently a hard prerequisite for the webhook); or a delivery for the same `(uid, date)` already started — Omi takes an atomic Redis lock *before* the LLM call (TTL 2 hours), so later cron ticks in that window are no-ops even if the earlier run failed or skipped. Treat missing days as "no recap available", not failure.

**Request:** `POST /your-endpoint?uid=user123` (JSON body)

Verbatim payload example:

```json
{
  "uid": "user123",
  "created_at": "2024-01-15T22:00:00.123456+00:00",
  "summary": "{'id': '550e8400-...', 'date': '2024-01-15', 'headline': 'Productive day with three focused work sessions', ...}",
  "summary_json": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "date": "2024-01-15",
    "headline": "Productive day with three focused work sessions",
    "overview": "...",
    "day_emoji": "💼",
    "stats": {
      "total_conversations": 3,
      "total_duration_minutes": 87,
      "action_items_count": 4
    },
    "highlights": [],
    "action_items": [],
    "unresolved_questions": [],
    "decisions_made": [],
    "knowledge_nuggets": [],
    "locations": []
  }
}
```

Top-level field reference (verbatim from the doc):

| Field | Type | Description |
| --- | --- | --- |
| `uid` | string | User identifier (also in query param) |
| `created_at` | string (ISO 8601 with `+00:00` offset) | Webhook send time in UTC |
| `summary_json` | object | **Recommended.** The daily summary as a real JSON object. Use this for any new integration. |
| `summary` | string | **Legacy.** The same payload serialized via Python's `str(...)`, kept for backward compatibility. |

**Legacy `summary` trap:** it is a Python-`str(dict)` single-quoted literal (e.g. `"{'headline': '...'}"`) — **not parseable by `JSON.parse`**; reading it requires something like `ast.literal_eval`. It will be deprecated in a future release. Use `summary_json`.

Full `summary_json` shape (verbatim):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "date": "2024-01-15",
  "created_at": "2024-01-15T22:00:00.000000",
  "headline": "Productive day with three focused work sessions",
  "overview": "You had a productive day that included a project planning meeting, a deep-work coding session, and a team retrospective.",
  "day_emoji": "💼",
  "stats": {
    "total_conversations": 3,
    "total_duration_minutes": 87,
    "action_items_count": 4
  },
  "highlights": [
    {
      "topic": "Q2 Roadmap",
      "emoji": "🗺️",
      "summary": "Locked in the Q2 feature priorities with the product team.",
      "conversation_ids": ["conv_abc123"]
    }
  ],
  "action_items": [
    {
      "description": "Send project proposal to design team by Friday",
      "priority": "high",
      "completed": false,
      "source_conversation_id": "conv_abc123"
    }
  ],
  "unresolved_questions": [
    {
      "question": "Which deployment pipeline should we adopt?",
      "conversation_id": "conv_abc123"
    }
  ],
  "decisions_made": [
    {
      "decision": "Migrate analytics to BigQuery",
      "conversation_id": "conv_abc123"
    }
  ],
  "knowledge_nuggets": [
    {
      "insight": "GitHub Actions reusable workflows can take typed inputs since 2023",
      "conversation_id": "conv_abc123"
    }
  ],
  "locations": [
    {
      "name": "Home office",
      "latitude": 37.7749,
      "longitude": -122.4194,
      "time": "09:30"
    }
  ]
}
```

**Two distinct `created_at` timestamps:** the top-level one is the webhook send time, UTC with explicit `+00:00` offset; the one *inside* `summary_json` (and inside legacy `summary`) is when the LLM pipeline built the summary object — also UTC but a **naive** ISO 8601 string with no offset suffix. Close in time but not identical.

---

## Building an integration (doc's steps)

1. Choose trigger type(s).
2. Set up a POST endpoint (testing suggestion: webhook.site or webhook-test.com). It should accept POST, parse JSON body (or binary for audio), read `uid` from query params, and **return 200 OK quickly**.
3. Implement logic. Doc's FastAPI example handler signature: `async def handle_memory(request: Request, uid: str)` with `memory = await request.json()`.
4. Test via Developer Mode.
5. Submit/publish through the Omi mobile app.

## Testing / Developer Mode

1. Omi app → Settings → Enable Developer Mode → Developer Settings.
2. Webhook URL fields (one per trigger):
   - Memory Triggers → "Memory Creation Webhook"
   - Real-Time → "Real-Time Transcript Webhook"
   - Audio Bytes → "Audio Bytes Webhook" (optionally with `,seconds` suffix)
   - Day Summary → "Day Summary Webhook"
3. Test memory triggers: any memory → 3-dot menu → Developer Tools → "Trigger webhook with existing data" (no new memory needed).
4. Test realtime: just start speaking; the endpoint receives updates immediately.
5. **Day Summary caveat:** the webhook only fires on the scheduled cron path. The in-app "Generate Summary" trigger (Settings → Daily Summary → ⋮ menu) regenerates the summary on demand but does **not** POST to the developer webhook. Fastest validation: enable the webhook, set the delivery hour to the next upcoming hour, and wait for the cron tick.
6. Doc tip: point the webhook at webhook.site first to see exactly what Omi sends before writing code.

## App Submission Fields

| Field | Required | Description |
| --- | --- | --- |
| Webhook URL | Yes | Your POST endpoint for receiving data |
| Setup Completed URL | No | GET endpoint returning `{"is_setup_completed": boolean}` |
| Auth URL | No | URL for user authentication (uid appended automatically) |
| Setup Instructions | No | Text or link explaining how to configure your app |

## Related pages (for follow-up verification if we need them)

- `/doc/developer/api` — personal Omi data API
- `/doc/developer/apps/Import` — create conversations/memories via REST
- `/doc/developer/apps/AudioStreaming` — raw audio guide
- `/doc/developer/apps/ChatTools`, `/doc/developer/apps/Oauth`, `/doc/developer/apps/Notifications`, `/doc/developer/apps/PromptBased`, `/doc/developer/apps/Introduction`
- Full page index: `https://docs.omi.me/llms.txt`; raw markdown of any page at `<url>.md`.


---

# https://docs.omi.me/doc/developer/apps/ChatTools
fetched: true

# Omi Chat Tools (docs.omi.me/doc/developer/apps/ChatTools)

Verified 2026-07-30 against the raw page markdown (`https://docs.omi.me/doc/developer/apps/ChatTools.md`; full doc index at `https://docs.omi.me/llms.txt`).

## Verdict vs our spec expectation

CONFIRMED: manifest format, request payload carrying `uid` / `app_id` / `tool_name` / extracted params, response as `result` or `error`, and the auth model as described below. Additions beyond our expectation:

1. Request payload may also carry an optional `geolocation` object (omitted entirely when unavailable — never `null`).
2. Tools can use GET (params become query params), not only POST.
3. A separate `chat_messages` manifest block + notification API lets the app push messages proactively (rate-limited 10/hour/app/user).
4. IMPORTANT GAP: the page documents NO mechanism for your endpoint to verify a call actually came from Omi (no signing secret, no Omi-side auth header on tool calls). "Auth" on this page means your own user-level OAuth tokens keyed by `uid`, plus a Bearer app API key only for the outbound notification API.
5. Doc inconsistency: the troubleshooting section says to check "that `chat_tools` array is properly formatted" but the manifest schema uses `"tools"`. Treat `tools` as the canonical key.

## Prerequisite

Chat Tools require the app to have the `external_integration` capability enabled. They are not a separate capability — a feature of external-integration apps. Tools become available in a user's Omi chat automatically when the user installs the app.

## Flow (per the page's sequence diagram)

1. User makes a natural-language request in Omi chat.
2. Omi's AI decides to use your tool.
3. Omi sends `POST /api/send_message` (your endpoint) with `{uid, app_id, tool_name, geolocation?, ...params}`.
4. Your server processes and returns `{result: "Message sent!"}` (or `{error: ...}`).
5. Omi displays the response to the user.

## Manifest

Hosted on YOUR server; Omi fetches it when you create/update the app in the Omi App Store ("Chat Tools Manifest URL" field, under the External Integration capability). Modify the manifest and re-save the app to refresh definitions.

Recommended location: `https://your-app.com/.well-known/omi-tools.json` (also acceptable: `/omi/manifest.json`, `/api/tools-manifest`). Must be accessible via HTTPS.

Verbatim example:

```json
{
  "tools": [
    {
      "name": "send_slack_message",
      "description": "Send a message to a Slack channel. Use this when the user wants to send a message, post an update, or notify a channel in Slack.",
      "endpoint": "/api/send_message",
      "method": "POST",
      "parameters": {
        "properties": {
          "channel": {
            "type": "string",
            "description": "The Slack channel to send to (e.g., '#general')"
          },
          "message": {
            "type": "string",
            "description": "The message text to send"
          }
        },
        "required": ["channel", "message"]
      },
      "auth_required": true,
      "status_message": "Sending message to Slack..."
    }
  ]
}
```

Note (verbatim): "You can use relative paths (e.g., `/api/send_message`) in your manifest. Omi will automatically resolve them using your `App Home URL` as the base URL."

### Manifest Schema Reference (tool object)

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Unique tool identifier (e.g., `send_slack_message`) |
| `description` | string | Yes | Detailed description for the AI to understand when/how to use the tool |
| `endpoint` | string | Yes | URL endpoint (can be relative or absolute) |
| `method` | string | No | HTTP method (default: `POST`) |
| `parameters` | object | No | JSON Schema defining tool parameters |
| `auth_required` | boolean | No | Whether user auth is required (default: `true`) |
| `status_message` | string | No | Message shown to user when tool is called (if absent, Omi generates a default based on the tool name) |

### Parameters schema shape

```json
{
  "parameters": {
    "properties": {
      "param_name": {
        "type": "string | integer | boolean | array | object",
        "description": "Description of what this parameter does"
      }
    },
    "required": ["param_name"]
  }
}
```

(Note: no top-level `"type": "object"` wrapper in the documented shape — just `properties` + `required`.)

Method guidance table: `POST` = creating resources / sending data (most common); `GET` = retrieving data (parameters as query params); `PUT/PATCH` = updating; `DELETE` = deleting.

## Tool invocation: request format (Omi -> your endpoint)

Endpoints accept POST with JSON payload (or GET with query parameters). Standard fields sent on every call: `uid` (User ID / Firebase UID), `app_id` (your app ID), `tool_name` (name of the tool being called), `geolocation` (optional), plus the tool-specific parameters flattened at the TOP LEVEL of the same object (not nested under a `params` key).

Verbatim POST example:

```json
{
  "uid": "user_firebase_id",
  "app_id": "your_app_id",
  "tool_name": "send_slack_message",
  "channel": "#general",
  "message": "Hello from Omi!",
  "geolocation": {
    "latitude": 30.2672,
    "longitude": -97.7431,
    "address": "123 Main St, Austin, TX 78701",
    "google_place_id": "ChIJLwPMoJm1RIYRetVp1EtGm10",
    "location_type": "approximate"
  }
}
```

Verbatim GET example:

```
GET /api/search?uid=user_id&app_id=app_id&tool_name=search_slack_messages&query=meeting
```

### Geolocation object

| Field | Type | Description |
|---|---|---|
| `latitude` | float | User's latitude in decimal degrees |
| `longitude` | float | User's longitude in decimal degrees |
| `address` | string \| null | Reverse-geocoded human-readable address |
| `google_place_id` | string \| null | Google Maps place identifier |
| `location_type` | string \| null | How the location was determined (e.g., `approximate`) |

Verbatim note: "The `geolocation` field is **only present when location data is available**. If the user has never granted location permission or their cached location has expired, the field is **omitted entirely** from the payload — it's not set to `null`. Always treat it as optional when parsing." Location data is cached server-side for 30 minutes; if the user moves significantly, the tool receives updated coordinates on the next call.

## Tool invocation: response format (your endpoint -> Omi)

Return JSON with exactly one of:

- Success — HTTP 200: `{ "result": "Successfully sent message to #general" }` (`result`: success message, string)
- Error — HTTP `400`, `401`, or `500`: `{ "error": "Slack not connected. Please connect your Slack account." }` (`error`: error message, string)

The page's examples also use 404 ("Channel not found") and 429 ("Rate limit exceeded") for errors. Error messages should be user-facing and actionable (they are shown to the user); never leak sensitive info (e.g., prefer "Service temporarily unavailable" over internals).

## Auth

- Tool endpoint calls FROM Omi carry no documented Omi-side credential/signature. The documented model is user-level: your app stores OAuth tokens (from your own OAuth flow — see the separate OAuth Guide, `/doc/developer/apps/Oauth`) in your own database keyed by `uid`; on each tool call you look up the token for `uid` and return `401` with `{"error": "... not connected. Please connect your account."}` if absent. `auth_required` in the manifest flags whether user auth is needed (default `true`).
- Best practices: store tokens encrypted; implement token refresh for long sessions; rate-limit your own endpoints (the page shows a sample 100 req/60s-per-uid Flask decorator as YOUR protection, not an Omi-imposed limit).

## Proactive chat messages (separate from tool calls)

Enable via a `chat_messages` object at the manifest ROOT (sibling of `tools`):

```json
{
  "tools": [...],
  "chat_messages": {
    "enabled": true,
    "target": "app",
    "notify": false
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Whether your app can send chat messages |
| `target` | string | `"app"` | Where messages appear: `"app"` (app-specific chat) or `"main"` (main chat) |
| `notify` | boolean | `false` | Whether to send a push notification with the message |

Once enabled, send via the notification API:

- Endpoint: `POST https://api.omi.me/v1/integrations/notification`
- Headers: `Authorization: Bearer YOUR_APP_API_KEY`, `Content-Type: application/json`
- Body fields (all required): `uid` (string, the user's Firebase UID), `aid` (string, your app's ID — note it is `aid` here, not `app_id`), `message` (string, the message content)
- Success = HTTP 200.

### Rate limits (the only Omi-imposed limits on this page)

- Chat messages: maximum 10 messages per hour per app per user; exceeding returns HTTP 429 with a `Retry-After` header. Abuse (spam/excessive notifications) may get the app removed from the store.
- No rate limit is documented for inbound tool calls.

## Testing (from the page)

1. Test endpoints directly with curl/Postman before adding to the app, e.g.:
   ```bash
   curl -X POST https://your-server.com/api/send_message \
     -H "Content-Type: application/json" \
     -d '{"uid": "test_user_id", "app_id": "slack-integration", "tool_name": "send_slack_message", "channel": "#general", "message": "Test message"}'
   ```
2. Create the app in the Omi App Store (add tool definitions via the manifest URL).
3. Install it in your test account.
4. If auth is required, click the connect button in app settings.
5. Test in chat with natural phrasing ("Send a message to #general saying hello").

No separate developer/sandbox mode is documented — testing is via a real app installed in your own account.

## Troubleshooting (verbatim highlights)

- Tool not appearing in chat: verify the app is installed and enabled (`enabled: true`); check that the `chat_tools` array is properly formatted [sic — the manifest key is `tools`; likely a doc drift from an older inline-definition format]; ensure endpoints are accessible; verify `external_integration` capability.
- Tool calls failing: check endpoint logs, auth, response-format compliance, that required parameters are being sent; test directly with curl.
- AI not using the tool: make the description more specific about WHEN to use it, add examples in the description, use a descriptive name.

## Related pages (for follow-up fetches)

- Developer API: `/doc/developer/api` — personal Omi data
- Data Import APIs: `/doc/developer/apps/Import` — create conversations/memories via REST
- Integrations: `/doc/developer/apps/Integrations`
- OAuth Guide: `/doc/developer/apps/Oauth`
- Notifications: `/doc/developer/apps/Notifications`
- Complete working example (OAuth + multiple tools): `/doc/developer/apps/examples/Slack`


---

# https://docs.omi.me/doc/developer/apps/Notifications
fetched: true

# Omi — Sending Notifications (docs.omi.me/doc/developer/apps/Notifications)

Verified 2026-07-30 against both the rendered page (WebFetch) and the raw Mintlify markdown (`https://docs.omi.me/doc/developer/apps/Notifications.md`). Both sources agree. Page tagline: "Send push notifications to Omi users from your apps - both direct text notifications and AI-generated proactive notifications."

## SPEC VERIFICATION — expectation vs. page

Expected: "Direct notifications API: endpoint, auth, payload {title/body?}, rate limits, difference from proactive notifications."

- Endpoint + auth: CONFIRMED (see below).
- **Payload `{title, body}`: REFUTED.** There is NO JSON body and NO `title`/`body` fields. The direct API takes exactly two **query parameters**: `uid` and `message`. The examples send `Content-Type: application/json` as a header but no request body at all.
- **Rate limits for direct: NOT DOCUMENTED.** The only explicit rate limit on the page applies to *proactive* notifications ("1 proactive notification per user per app every 30 seconds"). Direct notifications have a 429 "Rate limited" error code listed generically, but no stated numeric limit. Do not encode a specific direct-notification rate limit from this page.
- Difference from proactive: CONFIRMED and detailed below.

## Direct Notifications (the one we implement)

"Send immediate messages to specific users. Perfect for alerts, updates, and responses to user actions."

Flow: `Your Server --POST /notification--> Omi API --Push--> User`

### API Reference (verbatim table)

| Setting | Value                                                      |
| ------- | ---------------------------------------------------------- |
| Method  | `POST`                                                     |
| URL     | `https://api.omi.me/v2/integrations/{app_id}/notification` |
| Auth    | `Bearer <YOUR_APP_SECRET>`                                 |

**Query Parameters (verbatim):**

| Parameter | Required | Description          |
| --------- | -------- | -------------------- |
| `uid`     | Yes      | Target user's Omi ID |
| `message` | Yes      | Notification text    |

- `{app_id}` goes in the URL path; the App Secret goes in the `Authorization: Bearer` header. "You'll need your App ID and App Secret from the Omi developer portal."
- Docs warning: "Store credentials securely - never commit them to version control."

### Canonical request (verbatim from docs)

```bash
curl -X POST "https://api.omi.me/v2/integrations/${OMI_APP_ID}/notification?uid=USER_ID&message=Hello!" \
  -H "Authorization: Bearer ${OMI_APP_SECRET}" \
  -H "Content-Type: application/json"
```

The Python example passes the same two values via `params=` (querystring), not `json=`:

```python
response = requests.post(
    f'https://api.omi.me/v2/integrations/{app_id}/notification',
    params={'uid': user_id, 'message': message},
    headers={'Authorization': f'Bearer {app_secret}'}
)
```

The Node example builds `url.searchParams.set('uid', ...)` / `set('message', ...)` and calls `fetch(url, {method: 'POST', headers: {Authorization, 'Content-Type': 'application/json'}})`, then `response.json()` — so a JSON response body is expected on success, but its shape is not documented ("Check the response status code to confirm delivery.").

### Error codes (verbatim table; shared by both notification types)

| Code | Meaning        | Solution                                             |
| ---- | -------------- | ---------------------------------------------------- |
| 401  | Unauthorized   | Verify API credentials and Bearer token format       |
| 404  | User not found | Check that user ID exists and has your app installed |
| 429  | Rate limited   | Implement rate limiting with exponential backoff     |
| 500  | Server error   | Retry with backoff, check Omi status page            |

Troubleshooting checklist for "Direct Notifications Not Sending": API credentials are correct; User ID is valid; Bearer token is properly formatted; Request includes required headers.

Note the 404 semantics: the target user must exist AND have your app installed.

## Proactive Notifications (NOT implementing — context only)

- AI-generated, context-aware messages. Your webhook receives real-time transcripts and returns a *prompt template*; Omi fills in user context and generates the message. You never control the exact text (unlike direct).
- Requires app capabilities `["external_integration", "proactive_notification"]`, with `external_integration: {triggers_on: "transcript_processed", webhook_url: ...}` and `proactive_notification: {scopes: ["user_name", "user_facts", "user_context", "user_chat"]}`; user must install the app and grant scopes.
- Webhook incoming: `POST /your-webhook?session_id=abc123&uid=user123` with body `{"session_id": "abc123", "segments": [{"text": ..., "speaker": "SPEAKER_01", "is_user": false}]}`.
- Webhook response to trigger a notification: `{"session_id": ..., "notification": {"prompt": "... {{user_name}} {{user_facts}} {{user_context}} ...", "params": ["user_name", "user_facts", "user_context"]}}`; to skip: `{"session_id": ...}` only.
- Scopes → template variables: `user_name`→`{{user_name}}` (display name), `user_facts`→`{{user_facts}}`, `user_context`→`{{user_context}}`, `user_chat`→`{{user_chat}}` (recent chat history with your app).
- **Rate limit (verbatim, proactive only): "1 proactive notification per user per app every 30 seconds."**
- Prompt must be at least 5 characters (from troubleshooting).

## Testing / developer mode

The page's Testing steps sit under the Proactive section (there are no direct-specific testing steps): 1) Open Omi app → Settings → Developer Mode; 2) Install your app in Developer Mode and grant requested scopes; 3) Configure your webhook URL in Developer Settings; 4) Say trigger phrases in a conversation; 5) Notification should appear within 30 seconds. For direct notifications, testing reduces to: get App ID + App Secret from the developer portal, have a target user with your app installed, POST and check the status code.

## Best practices stated by the docs

Rate limiting (implement delays, avoid duplicates, group related notifications); keep messages concise; retry with exponential backoff and log errors; store credentials securely, validate user IDs before sending, HTTPS everywhere.

## Related pages (for later)

`/doc/developer/apps/Integrations` (webhook integrations), `/doc/developer/apps/Oauth`, `/doc/developer/apps/ChatTools`, `/doc/developer/apps/Submitting`. Full page list: `https://docs.omi.me/llms.txt`.



---

# https://docs.omi.me/doc/developer/apps/Import
fetched: true

# Omi Data Import APIs (docs.omi.me/doc/developer/apps/Import)

Verified 2026-07-30 via raw Mintlify markdown (`https://docs.omi.me/doc/developer/apps/Import.md`) cross-checked with a rendered-page fetch. Both sources agree.

## Verdict vs our spec expectation

- CONFIRMED: Import API for writing conversations and memories INTO Omi exists, with endpoints, auth, and payload shapes as documented below. It also includes READ endpoints (conversations + memories), not just writes.
- REFUTED / MISSING: **The page documents NO dedupe semantics.** No mention of deduplication, idempotency keys, duplicate handling, or merge behavior anywhere on the page. Writes are fire-and-forget: success is `200 OK` with an empty body `{}` and the content is "created asynchronously" — no created-resource id is returned, so a client cannot even correlate what it wrote. If our spec assumes dedupe, we must implement it client-side (e.g. track what we've sent) or verify empirically.
- No numeric rate limits are published — only a 429 status with exponential-backoff guidance.
- The page also says the Import API "supports creating and updating conversations, memories, and action items" and points to `/api-reference/introduction` for the full endpoint list — action-item and update endpoints are NOT documented on this page.

## Base URL

`https://api.omi.me`

## Quick reference

| Capability | Method | Endpoint |
|---|---|---|
| Create Conversation | `POST` | `/v2/integrations/{app_id}/user/conversations?uid={user_id}` |
| Create Memories | `POST` | `/v2/integrations/{app_id}/user/memories?uid={user_id}` |
| Read Conversations | `GET` | `/v2/integrations/{app_id}/conversations?uid={user_id}` |
| Read Memories | `GET` | `/v2/integrations/{app_id}/memories?uid={user_id}` |

Note the asymmetry: create paths include `/user/`, read paths do not. `uid` (the target user id) is a query parameter on every call; `app_id` is a path parameter.

## Auth

- Header: `Authorization: Bearer sk_your_api_key_here`
- "The API key must belong to the app specified in the URL path (`app_id`)."
- Keys are created in the Omi mobile app: Apps → Create App → App Capabilities → **External Integration** → select **Imports** and the specific capabilities; then the app's management page → **API Keys** → **Create Key**. The key is shown once only.
- The target user must have explicitly enabled the app in their Omi account, or requests fail 403.

## Create Conversation — `POST /v2/integrations/{app_id}/user/conversations?uid={user_id}`

Request body (example verbatim):

```json
{
  "text": "The full text content of the conversation",
  "started_at": "2024-07-21T22:34:43.384323+00:00",
  "finished_at": "2024-07-21T22:35:43.384323+00:00",
  "text_source": "audio_transcript",
  "text_source_spec": "phone_call",
  "language": "en",
  "geolocation": {
    "latitude": 37.7749,
    "longitude": -122.4194
  }
}
```

Field reference (verbatim from docs):

| Field | Required | Default | Description |
|---|---|---|---|
| `text` | Yes | - | The full text content of the conversation |
| `started_at` | No | Current time | When the conversation started (ISO 8601) |
| `finished_at` | No | started_at + 5min | When the conversation ended (ISO 8601) |
| `text_source` | No | `audio_transcript` | Source type: `audio_transcript`, `message`, or `other_text` |
| `text_source_spec` | No | - | Additional source detail (e.g., `phone_call`, `sms`, `email`) |
| `language` | No | `en` | Language code |
| `geolocation` | No | - | Object with `latitude` and `longitude` coordinates |

Response: **200 OK with body `{}`**. "The conversation is created asynchronously in the user's account." No id returned.

Doc examples pass multi-speaker transcripts as plain text with `Speaker: line` formatting separated by blank lines (e.g. `"John: Hi Sarah...\n\nSarah: It was great!..."`). Omi extracts structured data (title, overview, action items) server-side.

## Create Memories — `POST /v2/integrations/{app_id}/user/memories?uid={user_id}`

Two mutually alternative shapes; **either `text` or `memories` is required** (both empty → 422).

### Option A: extract from raw text (Omi auto-extracts memories)

```json
{
  "text": "Your flight to Paris has been confirmed for May 15th, 2024. Departure: JFK at 9:30 PM.",
  "text_source": "email",
  "text_source_spec": "travel_confirmation"
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `text` | Yes* | - | Text content from which memories will be extracted |
| `text_source` | No | `other` | Source type: `email`, `social_post`, or `other` |
| `text_source_spec` | No | - | Additional source detail |

NOTE: `text_source` enum here (`email` / `social_post` / `other`) differs from the conversation endpoint's enum (`audio_transcript` / `message` / `other_text`). Don't share one constant set.

### Option B: explicit structured memories

```json
{
  "memories": [
    {
      "content": "User is allergic to peanuts and shellfish",
      "tags": ["health", "allergies", "important"]
    },
    {
      "content": "User's mother's birthday is on August 15th",
      "tags": ["family", "dates"]
    }
  ],
  "text_source": "other",
  "text_source_spec": "user_profile"
}
```

| Field | Required | Description |
|---|---|---|
| `memories` | Yes* | Array of memory objects |
| `memories[].content` | Yes | The memory content |
| `memories[].tags` | No | Array of categorization tags |

Response: **200 OK with body `{}`**. "Memories are extracted/saved asynchronously." No ids returned.

## Read Conversations — `GET /v2/integrations/{app_id}/conversations?uid={user_id}`

Query parameters:

| Parameter | Default | Description |
|---|---|---|
| `limit` | 100 | Maximum conversations to return (max: 1000) |
| `offset` | 0 | Number to skip for pagination |
| `include_discarded` | false | Include discarded conversations |
| `statuses` | - | Filter by statuses (comma-separated; allowed values not documented) |

Response shape (verbatim example):

```json
{
  "conversations": [
    {
      "id": "conversation_id_1",
      "created_at": "2024-03-15T12:00:00Z",
      "started_at": "2024-03-15T12:00:00Z",
      "finished_at": "2024-03-15T12:05:00Z",
      "text": "Full conversation text content...",
      "structured": {
        "title": "Conversation Title",
        "overview": "Brief overview of the conversation"
      },
      "transcript_segments": [
        {"text": "Segment text...", "start_time": 0, "end_time": 10}
      ],
      "geolocation": {"latitude": 37.7749, "longitude": -122.4194}
    }
  ]
}
```

## Read Memories — `GET /v2/integrations/{app_id}/memories?uid={user_id}`

Query parameters: `limit` (default 100, max 1000), `offset` (default 0).

Response shape (verbatim example):

```json
{
  "memories": [
    {
      "id": "memory_id_1",
      "content": "User prefers vegetarian food options",
      "created_at": "2024-03-15T12:00:00Z",
      "tags": ["preferences", "food"]
    }
  ]
}
```

## Errors (all endpoints)

| Status | Error | Description |
|---|---|---|
| 400 | Bad Request | Invalid request format or missing required fields |
| 401 | Unauthorized | Missing or invalid `Authorization` header |
| 403 | Forbidden | Invalid API key, app not enabled by user, or app lacks required capability |
| 404 | Not Found | App not found |
| 422 | Unprocessable Entity | Valid format but invalid content (e.g., empty text and memories) |
| 429 | Too Many Requests | Rate limit exceeded - implement exponential backoff |

Backoff guidance (verbatim): "Start with a 1-second delay and double it on each retry." No numeric rate-limit thresholds or headers are documented.

## Testing / developer-mode instructions

No sandbox environment exists. The docs' testing guidance is:

1. "Create a separate API key for testing to avoid affecting production data" (dev keys hit the same live user account).
2. "Clearly mark test conversations (e.g., prefix with \"[TEST]\") so they're easy to identify and clean up."
3. Verify created content by opening the Omi app.
4. For conversations, verify title / overview / action items were extracted correctly.

Common-issues table: auth errors → key must match `app_id` in the URL; permission errors → user must have enabled the app AND the app must hold the capability; empty response on memory create → must provide `text` or `memories`; rate limiting → exponential backoff from 1s.

## Implementation notes for our client

- Write success gives no resource id and creation is async → build our own idempotency/dedupe layer (e.g. keyed on content hash + `started_at`) and reconcile via the Read endpoints if needed.
- Two different `text_source` enums (conversation vs memory create) — model as separate types.
- Prerequisite chain before any call works: External Integration app with Imports capability + API key + user has enabled the app; expect 403 otherwise.
- Related pages on the same docs site (from llms index pointer): `/doc/developer/api` (personal Developer API), `/doc/developer/apps/Integrations` (trigger-based integration apps), `/api-reference/introduction` (full endpoint list incl. the mentioned-but-undocumented update + action-item endpoints).


---

# https://docs.omi.me/api-reference/introduction
fetched: true

# Omi Developer API - verified notes (docs.omi.me, fetched 2026-07-30)

Sources fetched raw (Mintlify serves raw markdown at `<url>.md`): `api-reference/introduction.md`, `api-reference/endpoint/memories/create.md`, `api-reference/memories/create-memory.md`, `api-reference/endpoint/conversations/list.md`, `api-reference/conversations/get-conversations.md`, `doc/developer/api/overview.md`, plus the full page index at `https://docs.omi.me/llms.txt`. WebFetch of the intro page agreed with the raw markdown.

## Verdict on our spec expectation

- Base `https://api.omi.me/v1/dev` - CONFIRMED (the Quick Start page states this base verbatim), with a nuance: the intro page gives the base as `https://api.omi.me` and every data endpoint path is `/v1/dev/user/...` (note the `/user/` segment - it is `/v1/dev/user/memories`, NOT `/v1/dev/memories`). API-key management endpoints drop `/user/`: `/v1/dev/keys`.
- Bearer `omi_dev_` keys - CONFIRMED (`Authorization: Bearer omi_dev_your_api_key_here`).
- Memories, conversations, action items endpoints - CONFIRMED; the API also has folders, goals, and API-key endpoints not in our spec.
- One documentation contradiction worth knowing (detailed below): the docs ship TWO parallel endpoint-page families backed by different OpenAPI specs; one declares auth as a Firebase ID token (`firebaseBearer`), the other as the Developer API key (`developerApiKey`). For an `omi_dev_` client, follow the Developer spec (`/api-reference/openapi.json`).

## Base URL and auth

- Server: `https://api.omi.me` (Production). Quick Start: "Base URL `https://api.omi.me/v1/dev`"; "For self-hosted instances, replace with your backend URL."
- Auth header (all requests): `Authorization: Bearer omi_dev_your_api_key_here`
- OpenAPI security scheme (Developer spec `openapi.json`): `developerApiKey` - http bearer, bearerFormat "Omi Developer API key", description: "Send `Authorization: Bearer <omi_developer_api_key>`."
- Key acquisition: intro page says "Settings -> Developer -> Create Key in the Omi app"; Quick Start says the Omi web app "Developer -> API Keys", create a key and "choose only the scopes your integration needs". "Copy the key immediately - you won't be able to see it again!"
- Warning (verbatim from intro): "MCP keys (`omi_mcp_...`) are only for the MCP server at `/v1/mcp/sse`. They are not accepted by REST Developer API endpoints. Use a Developer API key (`omi_dev_...`) for endpoints such as `/v1/dev/user/memories` and `/v1/dev/user/conversations`."
- Testing gotcha (verbatim note from Quick Start): "Key creation is self-service. Memory endpoints additionally require server-side account readiness, so a valid key with `memories:read` can return `403` with code `developer_memory_access_not_ready`. That response does not mean the key is invalid or missing its scope."

## Rate limits

| Limit | Value |
| --- | --- |
| Per minute | 100 requests per API key |
| Per day | 10,000 requests per user |

Headers on every response: `X-RateLimit-Limit: 100`, `X-RateLimit-Remaining: 95`, `X-RateLimit-Reset: 1642694400` (epoch seconds).

## Endpoints at a glance (from Quick Start)

- Memories: `GET /v1/dev/user/memories` (retrieve), `POST /v1/dev/user/memories` (create), `POST /v1/dev/user/memories/batch` (create up to 25)
- Action Items: `GET /v1/dev/user/action-items`, `POST /v1/dev/user/action-items`, `POST /v1/dev/user/action-items/batch` (up to 50)
- Conversations: `GET /v1/dev/user/conversations`, `POST /v1/dev/user/conversations` (create from text), `POST /v1/dev/user/conversations/from-segments`
- Folders: `GET /v1/dev/user/folders`
- API Keys: `GET /v1/dev/keys`, `POST /v1/dev/keys`, `DELETE /v1/dev/keys/{key_id}`
- Plus per llms.txt (not in the Quick Start tables): memory update/delete, conversation get/update/delete, action-item update/delete, goals CRUD + progress/history (`/api-reference/goals/*`), and `search-memories-vector` (`/api-reference/developer/search-memories-vector`).

## api-reference endpoint page index (from llms.txt)

Two parallel families document the same operations. Family A (`/api-reference/endpoint/...`) embeds the "Omi App Client API" spec (`app-client-openapi.json`); Family B (`/api-reference/<resource>/...`) embeds the "Omi Developer API" spec (`openapi.json`). Paths and request/response schemas are identical across the two; only the declared security differs (see contradiction section).

Family A - `/api-reference/endpoint/`:
- `action-items/create`, `action-items/create-batch`, `action-items/delete`, `action-items/list`, `action-items/update`
- `conversations/create`, `conversations/create-from-segments`, `conversations/delete`, `conversations/get`, `conversations/list`, `conversations/update`
- `folders/list`
- `keys/create`, `keys/list`, `keys/revoke`
- `memories/create`, `memories/create-batch`, `memories/delete`, `memories/list`, `memories/update`

Family B - `/api-reference/`:
- `action-items/create-action-item`, `create-action-items-batch`, `delete-action-item`, `get-action-items`, `update-action-item`
- `api-keys/create-key`, `delete-key`, `get-keys`
- `conversations/create-conversation`, `create-conversation-from-segments`, `delete-conversation-endpoint`, `get-conversation-endpoint`, `get-conversations`, `update-conversation-endpoint`
- `developer/search-memories-vector`
- `folders/get-user-folders`
- `goals/create-goal`, `delete-goal`, `get-goal`, `get-goal-history`, `get-goals`, `update-goal`, `update-goal-progress`
- `memories/create-memories-batch`, `create-memory`, `delete-memory`, `get-memories`, `update-memory`

Machine-readable specs: `https://docs.omi.me/api-reference/openapi.json` (Omi Developer API), `https://docs.omi.me/api-reference/app-client-openapi.json`, `https://docs.omi.me/api-reference/integration-public-openapi.json`. There is no llms-full.txt equivalent needed; every page serves raw at `.md`.

## POST /v1/dev/user/memories - Create Memory (verbatim schema)

operationId `createMemory`. Request body required, `application/json`, schema `CreateMemoryRequest`:

- `content` (string, REQUIRED) - "The content of the memory", minLength 1, maxLength 500
- `category` (MemoryCategory enum | null, optional) - "Memory category: interesting, system, or manual (auto-categorized if not provided)"
- `visibility` (string, optional, default `"private"`) - "Visibility: public or private"
- `tags` (array of string, optional, default `[]`) - "Tags associated with the memory"

`MemoryCategory` enum values: `interesting`, `system`, `manual`, `workflow`, `core`, `hobbies`, `lifestyle`, `interests`, `habits`, `work`, `skills`, `learnings`, `other`, `auto`.

Responses: `200` -> `DeveloperMemory`; `401` (ErrorResponse, "Missing or invalid authentication credentials."); `403` (Developer spec only: ErrorResponse, "Authenticated, but the token does not grant the required scope."); `422` -> `HTTPValidationError`.

`DeveloperMemory` (response object):
- `id` (string, REQUIRED)
- `content` (string, default `""`)
- `category` (MemoryCategory, default `interesting`)
- `visibility` (string | null, default `"private"`)
- `tags` (array of string)
- `created_at` (date-time string | null)
- `updated_at` (date-time string | null)
- `edited` (boolean, default false)
- `reviewed` (boolean, default false)
- `manually_added` (boolean, default false)
- `user_review` (boolean | null)
- `scoring` (string | null)

## GET /v1/dev/user/conversations - List Conversations (verbatim schema)

operationId `listConversations`. Query parameters (all optional):

- `start_date` (date-time string | null)
- `end_date` (date-time string | null)
- `categories` (string | null)
- `limit` (integer, default 25)
- `offset` (integer, default 0)
- `include_transcript` (boolean, default false) - "If True, includes full transcript_segments in the response"
- `folder_id` (string minLength 1 | null) - "Filter by folder ID (must be a non-empty string if provided)"
- `starred` (boolean | null) - "Filter by starred status (true/false)"

Responses: `200` -> bare JSON array of `DeveloperConversation` (no envelope, no pagination metadata - paginate via limit/offset); `401`; `403` (Developer spec); `422` -> `HTTPValidationError`.

`DeveloperConversation`:
- `id` (string, REQUIRED)
- `created_at` (date-time string, REQUIRED)
- `started_at` (date-time string | null, REQUIRED)
- `finished_at` (date-time string | null, REQUIRED)
- `structured` (DeveloperConversationStructured, REQUIRED)
- `transcript_segments` (array of DeveloperTranscriptSegment | null)
- `folder_id` (string | null)
- `folder_name` (string | null)
- `geolocation` (Geolocation | null)
- `language` (string | null)
- `source` (string | null)

`DeveloperConversationStructured`:
- `title` (string, REQUIRED)
- `overview` (string, REQUIRED)
- `category` (CategoryEnum, REQUIRED)
- `emoji` (string, default: the brain emoji character U+1F9E0)
- `action_items` (array of DeveloperConversationActionItem, default `[]`)
- `events` (array of DeveloperConversationEvent, default `[]`)

`CategoryEnum` values: `personal`, `education`, `health`, `finance`, `legal`, `philosophy`, `spiritual`, `science`, `entrepreneurship`, `parenting`, `romantic`, `travel`, `inspiration`, `technology`, `business`, `social`, `work`, `sports`, `politics`, `literature`, `history`, `architecture`, `music`, `weather`, `news`, `entertainment`, `psychology`, `real`, `design`, `family`, `economics`, `environment`, `other`.

`DeveloperTranscriptSegment`:
- `text` (string, REQUIRED)
- `start` (number, REQUIRED)
- `end` (number, REQUIRED)
- `id` (string | null)
- `speaker_id` (integer | null)
- `speaker_name` (string | null)

`DeveloperConversationActionItem`:
- `description` (string, REQUIRED)
- `completed` (boolean, default false)
- `completed_at` (date-time string | null)
- `conversation_id` (string | null)
- `created_at` (date-time string | null)
- `updated_at` (date-time string | null)
- `due_at` (date-time string | null)

`DeveloperConversationEvent`:
- `title` (string, REQUIRED)
- `start` (date-time string, REQUIRED)
- `description` (string, default `""`)
- `duration` (integer, default 30)
- `created` (boolean, default false)

`Geolocation`:
- `latitude` (number, REQUIRED, -90..90)
- `longitude` (number, REQUIRED, -180..180)
- `address` (string | null)
- `google_place_id` (string | null)
- `location_type` (string | null)

Error shapes: `ErrorResponse` = `{ detail: string | array | object }` (REQUIRED). `HTTPValidationError` = `{ detail: ValidationError[] }` where `ValidationError` = `{ loc: (string|integer)[], msg: string, type: string }` (all three REQUIRED).

## Contradiction / nuance report

1. `/user/` segment: our spec said "base https://api.omi.me/v1/dev; memories, conversations, action items endpoints". Correct, but the resource paths are `/v1/dev/user/<resource>` (memories/conversations/action-items/folders/goals) while key management is `/v1/dev/keys`. A client that builds `<base>/memories` from base `.../v1/dev` will 404; it must be `.../v1/dev/user/memories`.
2. Dual OpenAPI specs with conflicting auth declarations: Family A pages (`/api-reference/endpoint/...`) embed the "Omi App Client API" spec whose per-operation security is `firebaseBearer` ("Send `Authorization: Bearer <firebase_id_token>`", bearerFormat "Firebase ID token") and which omits the 403 response. Family B pages (`/api-reference/memories/...` etc.) embed `openapi.json` "Omi Developer API" with security `developerApiKey` (Omi Developer API key bearer) plus the 403 scope error. The prose intro and Quick Start unambiguously describe `omi_dev_` bearer keys for these same paths, so treat Family B / `openapi.json` as authoritative for a Developer API client; the same URL apparently accepts either credential type depending on client class.
3. Both specs set top-level `security: []` with security declared per-operation - do not read the top-level as "no auth".
4. Scopes exist (per-key, chosen at creation; `memories:read` named in docs) and are not part of our expectation; a 403 with `developer_memory_access_not_ready` on memory endpoints is a server-side readiness state, not a bad key.
5. Response of list endpoints is a bare array (no `{items, total}` envelope); success status for create is `200`, not `201`.


---

# https://docs.omi.me/llms.txt
fetched: true

# docs.omi.me/llms.txt — full docs index (verified 2026-07-30)

Fetched raw via curl (139 lines) and cross-checked with a second fetch; both agree. Structure: one `# Docs` heading, a `## Docs` section (129 page links, each `- [Title](URL.md): description`), and a `## OpenAPI Specs` section (5 links). Every doc page is also served as raw markdown at `<url>.md` (Mintlify).

**Expectation check: CONFIRMED with notes.** It is a full docs index covering apps / integrations / notifications / chat-tools / import / api-reference. Two deviations worth recording:

1. **`llms-full.txt` EXISTS** at `https://docs.omi.me/llms-full.txt` (HTTP 200, ~839 KB = the full text of every page in one file). Useful for bulk extraction.
2. **The api-reference tree is duplicated**: `/api-reference/<resource>/<verb>.md` AND `/api-reference/endpoint/<resource>/<verb>.md` are two parallel trees for the same endpoints (e.g. `conversations/create-conversation.md` vs `endpoint/conversations/create.md`). Pick one tree when scraping; content overlaps.

## Flags (grounded by fetching the pages themselves, not just the index)

**Webhook signing:** NO page documents webhook request signing (no HMAC, no signature header). Integration-app webhooks (`doc/developer/apps/Integrations.md`) authenticate by **URL/query params only**: `POST /your-endpoint?uid=user123`, `?session_id=abc123&uid=user123`, `?sample_rate=16000&uid=user123`. This matches our expectation (URL secrets only).

**Auth beyond URL secrets DOES exist for calls TO Omi (client → api.omi.me), three distinct schemes:**
- `doc/developer/apps/Notifications.md` — `Authorization: Bearer <YOUR_APP_SECRET>` (App ID + App Secret from the developer portal); endpoint `POST https://api.omi.me/v2/integrations/{app_id}/notification?uid=USER_ID&message=...`.
- `doc/developer/apps/Import.md` — `Authorization: Bearer sk_your_api_key_here` (per-app key, created in the app's management page → **API Keys** → Create Key; shown once). Endpoints: `POST /v2/integrations/{app_id}/user/conversations?uid={user_id}`, `POST /v2/integrations/{app_id}/user/memories?uid={user_id}`, `GET /v2/integrations/{app_id}/conversations?uid={user_id}`, `GET /v2/integrations/{app_id}/memories?uid={user_id}`.
- `doc/developer/api/overview.md` (Developer API) — `Authorization: Bearer omi_dev_your_key_here` (created in the Omi web app: **Developer → API Keys**, with optional scopes). Key mgmt endpoints: `GET /v1/dev/keys`, `POST /v1/dev/keys`, `DELETE /v1/dev/keys/{key_id}`.
- `doc/developer/apps/Oauth.md` — "OAuth" flow for app installs: user visits Omi's authorization page, is redirected back to the app's HTTPS **App Home URL** as `https://your-app.com/callback?uid=USER_UNIQUE_ID&state=YOUR_STATE` (token exchange handled inside Omi's page; the app receives uid + state, no access token). Optional `GET https://your-app.com/setup-status?uid=USER_ID` check.

**HUMAN_SETUP.md — pages a human must read (app creation / developer mode / payments):**
- `doc/developer/apps/Introduction.md` — app creation entry point: in the Omi app, **Explore → Create an App**; app types (prompt-based personas, integrations); "Earn Revenue" (paid apps exist).
- `doc/developer/apps/Submitting.md` — app-store submission: test in **Developer Mode** first; review typically within 24 h; **no fees** to submit or list.
- `doc/developer/apps/Notifications.md` — where App ID / App Secret come from (Omi developer portal).
- `doc/developer/apps/Import.md` — where per-app `sk_` API keys come from (app management page).
- `doc/developer/api/overview.md` + `doc/developer/api/keys.md` — where `omi_dev_` Developer API keys come from (web app, Developer → API Keys, scoped).
- `doc/developer/apps/Oauth.md` — App Home URL must be set in app settings (HTTPS required).

**Rate limits:** the index itself states none (it is only an index); check individual pages/openapi specs.

---

## Complete verbatim link list (## Docs section, 129 links, in file order)

### api-reference tree A (`/api-reference/<resource>/`)
- [Create Action Item](https://docs.omi.me/api-reference/action-items/create-action-item.md): Create a new action item for the authenticated user.
- [Create Action Items Batch](https://docs.omi.me/api-reference/action-items/create-action-items-batch.md): Create multiple action items in a batch.
- [Delete Action Item](https://docs.omi.me/api-reference/action-items/delete-action-item.md): Delete an action item by ID.
- [Get Action Items](https://docs.omi.me/api-reference/action-items/get-action-items.md): Get action items with optional filters. Locked action items are excluded.
- [Update Action Item](https://docs.omi.me/api-reference/action-items/update-action-item.md): Update an action item.
- [Create Key](https://docs.omi.me/api-reference/api-keys/create-key.md): Create a new Developer API key with optional scopes.
- [Delete Key](https://docs.omi.me/api-reference/api-keys/delete-key.md)
- [Get Keys](https://docs.omi.me/api-reference/api-keys/get-keys.md)
- [Create Conversation](https://docs.omi.me/api-reference/conversations/create-conversation.md): Create a new conversation from text for the authenticated user.
- [Create Conversation From Segments](https://docs.omi.me/api-reference/conversations/create-conversation-from-segments.md): Create a new conversation from structured transcript segments.
- [Delete Conversation Endpoint](https://docs.omi.me/api-reference/conversations/delete-conversation-endpoint.md): Delete a conversation by ID.
- [Get Conversation Endpoint](https://docs.omi.me/api-reference/conversations/get-conversation-endpoint.md): Get a single conversation by ID.
- [Get Conversations](https://docs.omi.me/api-reference/conversations/get-conversations.md): Get conversations with optional transcript inclusion.
- [Update Conversation Endpoint](https://docs.omi.me/api-reference/conversations/update-conversation-endpoint.md): Update a conversation's title or discard status.
- [Search Memories Vector](https://docs.omi.me/api-reference/developer/search-memories-vector.md): Search developer-readable default memory memory through hydrated vector candidates.

### api-reference tree B (`/api-reference/endpoint/<resource>/`) — duplicate of tree A + folders
- [Create Action Item](https://docs.omi.me/api-reference/endpoint/action-items/create.md)
- [Create Action Items (Batch)](https://docs.omi.me/api-reference/endpoint/action-items/create-batch.md)
- [Delete Action Item](https://docs.omi.me/api-reference/endpoint/action-items/delete.md)
- [List Action Items](https://docs.omi.me/api-reference/endpoint/action-items/list.md)
- [Update Action Item](https://docs.omi.me/api-reference/endpoint/action-items/update.md)
- [Create Conversation](https://docs.omi.me/api-reference/endpoint/conversations/create.md)
- [Create from Transcript Segments](https://docs.omi.me/api-reference/endpoint/conversations/create-from-segments.md)
- [Delete Conversation](https://docs.omi.me/api-reference/endpoint/conversations/delete.md)
- [Get Conversation](https://docs.omi.me/api-reference/endpoint/conversations/get.md)
- [List Conversations](https://docs.omi.me/api-reference/endpoint/conversations/list.md)
- [Update Conversation](https://docs.omi.me/api-reference/endpoint/conversations/update.md)
- [List Folders](https://docs.omi.me/api-reference/endpoint/folders/list.md): Get all folders for the authenticated user.
- [Create API Key](https://docs.omi.me/api-reference/endpoint/keys/create.md)
- [List API Keys](https://docs.omi.me/api-reference/endpoint/keys/list.md)
- [Revoke API Key](https://docs.omi.me/api-reference/endpoint/keys/revoke.md)
- [Create Memory](https://docs.omi.me/api-reference/endpoint/memories/create.md)
- [Create Memories (Batch)](https://docs.omi.me/api-reference/endpoint/memories/create-batch.md)
- [Delete Memory](https://docs.omi.me/api-reference/endpoint/memories/delete.md)
- [List Memories](https://docs.omi.me/api-reference/endpoint/memories/list.md)
- [Update Memory](https://docs.omi.me/api-reference/endpoint/memories/update.md): Update a memory's content, visibility, tags, or category.

### api-reference (remaining tree-A pages)
- [Get User Folders](https://docs.omi.me/api-reference/folders/get-user-folders.md): Get all folders for the authenticated user.
- [Create Goal](https://docs.omi.me/api-reference/goals/create-goal.md): Create a durable goal. Metrics are optional and other goals are never changed implicitly.
- [Delete Goal](https://docs.omi.me/api-reference/goals/delete-goal.md)
- [Get Goal](https://docs.omi.me/api-reference/goals/get-goal.md)
- [Get Goal History](https://docs.omi.me/api-reference/goals/get-goal-history.md): Get progress history for a goal.
- [Get Goals](https://docs.omi.me/api-reference/goals/get-goals.md): Get user goals.
- [Update Goal](https://docs.omi.me/api-reference/goals/update-goal.md)
- [Update Goal Progress](https://docs.omi.me/api-reference/goals/update-goal-progress.md): Update the progress value of a goal.
- [API Reference](https://docs.omi.me/api-reference/introduction.md): Complete reference for the Omi Developer API. Build integrations with memories, conversations, action items, and more.
- [Create Memories Batch](https://docs.omi.me/api-reference/memories/create-memories-batch.md)
- [Create Memory](https://docs.omi.me/api-reference/memories/create-memory.md)
- [Delete Memory](https://docs.omi.me/api-reference/memories/delete-memory.md)
- [Get Memories](https://docs.omi.me/api-reference/memories/get-memories.md)
- [Update Memory](https://docs.omi.me/api-reference/memories/update-memory.md)

### DIY assembly
- [Building the Device](https://docs.omi.me/doc/assembly/Build_the_device.md)
- [Parts List](https://docs.omi.me/doc/assembly/Buying_Guide.md)
- [Build Your Own Omi Device](https://docs.omi.me/doc/assembly/introduction.md)

### developer (app dev, streaming, protocol)
- [App Setup](https://docs.omi.me/doc/developer/AppSetup.md): Set up the Omi Flutter app for development.
- [Real-Time Audio Streaming](https://docs.omi.me/doc/developer/AudioStreaming.md): Stream audio bytes from your Omi device to any backend service in real time.
- [Contribution Guide](https://docs.omi.me/doc/developer/Contribution.md): Contribute to Omi and earn rewards! Some tasks have paid bounties.
- [Cursor Configuration (.cursor)](https://docs.omi.me/doc/developer/Cursor.md)
- [DevKit 2 Testing](https://docs.omi.me/doc/developer/DevKit2Testing.md)
- [App-Device Protocol](https://docs.omi.me/doc/developer/Protocol.md): BLE protocol specification for communicating with Omi wearable devices
- [Agent control plane](https://docs.omi.me/doc/developer/agent-control-plane.md)
- [Agent control plane invariants](https://docs.omi.me/doc/developer/agent-control-plane-invariants.md)

### developer/api (Developer API guides — DEV-RELEVANT)
- [Action Items](https://docs.omi.me/doc/developer/api/action-items.md)
- [Conversations](https://docs.omi.me/doc/developer/api/conversations.md)
- [Folders](https://docs.omi.me/doc/developer/api/folders.md)
- [API Keys](https://docs.omi.me/doc/developer/api/keys.md): Manage your Developer API keys
- [Memories](https://docs.omi.me/doc/developer/api/memories.md)
- [Quick Start](https://docs.omi.me/doc/developer/api/overview.md): Access your Omi data programmatically with the Developer API.

### developer/apps (integration apps — DEV-RELEVANT core)
- [Real-Time Audio Streaming](https://docs.omi.me/doc/developer/apps/AudioStreaming.md): Stream raw audio bytes from your Omi device to any backend for custom speech processing, VAD, or audio analysis.
- [Chat Tools](https://docs.omi.me/doc/developer/apps/ChatTools.md): Add custom chat tools to your Omi app that extend Omi's capabilities in user conversations.
- [Data Import APIs](https://docs.omi.me/doc/developer/apps/Import.md): Programmatically create and read conversations and memories in users' Omi accounts using the Integration Import APIs.
- [Integration Apps](https://docs.omi.me/doc/developer/apps/Integrations.md): Build webhook-based apps that connect Omi to external services. Process memories, real-time transcripts, raw audio, or daily summaries.
- [Building Apps for Omi](https://docs.omi.me/doc/developer/apps/Introduction.md): Create apps that extend Omi's capabilities... Publish to the app store and earn from your creations.
- [Sending Notifications](https://docs.omi.me/doc/developer/apps/Notifications.md): Send push notifications to Omi users from your apps - both direct text notifications and AI-generated proactive notifications.
- [OAuth Authentication](https://docs.omi.me/doc/developer/apps/Oauth.md): Integrate your application with Omi using OAuth 2.0 to securely access user data with explicit consent.
- [Open Source Your App](https://docs.omi.me/doc/developer/apps/OpenSource.md)
- [Prompt-Based Apps](https://docs.omi.me/doc/developer/apps/PromptBased.md): Customize Omi's behavior with prompts - no server required.
- [Publish Your App](https://docs.omi.me/doc/developer/apps/Submitting.md): Submit your app to the Omi app store. Learn the review process, guidelines, and best practices.
- [GitHub example](https://docs.omi.me/doc/developer/apps/examples/Github.md)
- [Omi Mentor example](https://docs.omi.me/doc/developer/apps/examples/OmiMentor.md)
- [Slack example](https://docs.omi.me/doc/developer/apps/examples/Slack.md)

### developer/backend (self-host / architecture)
- [Backend Setup](https://docs.omi.me/doc/developer/backend/Backend_Setup.md)
- [Storing Conversations & Memories](https://docs.omi.me/doc/developer/backend/StoringConversations.md)
- [Backend Deep Dive](https://docs.omi.me/doc/developer/backend/backend_deepdive.md)
- [Chat System Architecture](https://docs.omi.me/doc/developer/backend/chat_system.md)
- [Goal and thread lifecycle](https://docs.omi.me/doc/developer/backend/goal_workstream_lifecycle.md)
- [Listen + Pusher Pipeline](https://docs.omi.me/doc/developer/backend/listen_pusher_pipeline.md): Sequence diagrams for the /v4/listen WebSocket and Pusher processing pipeline
- [LLM Gateway](https://docs.omi.me/doc/developer/backend/llm_gateway.md)
- [Prod Backend Deploy and Hotfix Runbook](https://docs.omi.me/doc/developer/backend/prod_hotfix_runbook.md)
- [Task and Candidate lifecycle](https://docs.omi.me/doc/developer/backend/task_candidate_lifecycle.md)
- [Real-time Transcription](https://docs.omi.me/doc/developer/backend/transcription.md)

### developer/cli
- [For agents](https://docs.omi.me/doc/developer/cli/agents.md): Stable agent contract — JSON output, exit codes, retry semantics.
- [Command reference](https://docs.omi.me/doc/developer/cli/commands.md)
- [Install](https://docs.omi.me/doc/developer/cli/install.md)
- [Introduction](https://docs.omi.me/doc/developer/cli/introduction.md)
- [Quickstart](https://docs.omi.me/doc/developer/cli/quickstart.md): Get from zero to your data — pick browser OAuth or paste a dev API key.
- [Troubleshooting](https://docs.omi.me/doc/developer/cli/troubleshooting.md)

### developer (misc) / firmware / mcp / sdk
- [Desktop voice-turn architecture](https://docs.omi.me/doc/developer/desktop-voice-turns.md)
- [Compile Firmware](https://docs.omi.me/doc/developer/firmware/Compile_firmware.md)
- [MCP Examples](https://docs.omi.me/doc/developer/mcp/examples.md)
- [MCP Introduction](https://docs.omi.me/doc/developer/mcp/introduction.md): Connect AI assistants to your Omi data using the Model Context Protocol
- [MCP Setup](https://docs.omi.me/doc/developer/mcp/setup.md)
- [MCP Tools Reference](https://docs.omi.me/doc/developer/mcp/tools.md)
- [MCP Troubleshooting](https://docs.omi.me/doc/developer/mcp/troubleshooting.md)
- [Cloud Audio Storage](https://docs.omi.me/doc/developer/savingaudio.md)
- [React Native SDK](https://docs.omi.me/doc/developer/sdk/ReactNative.md)
- [Python SDK](https://docs.omi.me/doc/developer/sdk/python.md)
- [SDK Overview](https://docs.omi.me/doc/developer/sdk/sdk.md): Build on top of Omi with official SDKs for Python, Swift, and React Native
- [Swift SDK](https://docs.omi.me/doc/developer/sdk/swift.md)

### get_started / hardware / info / misc
- [Update Omi Firmware](https://docs.omi.me/doc/get_started/Flash_device.md)
- [Chat Tips & Best Practices](https://docs.omi.me/doc/get_started/chat_tips.md)
- [Introduction](https://docs.omi.me/doc/get_started/introduction.md)
- [Omi DevKit 1](https://docs.omi.me/doc/hardware/DevKit1.md)
- [Omi DevKit 2](https://docs.omi.me/doc/hardware/DevKit2.md)
- [Omi (Consumer CV1)](https://docs.omi.me/doc/hardware/OmiConsumer.md)
- [Painting OMI device](https://docs.omi.me/doc/hardware/PaintingOMI.md)
- [Assembly & BOM](https://docs.omi.me/doc/hardware/consumer/assembly.md)
- [Electronics](https://docs.omi.me/doc/hardware/consumer/electronics.md)
- [Open Source Hardware](https://docs.omi.me/doc/hardware/consumer/index.md)
- [License (hardware)](https://docs.omi.me/doc/hardware/consumer/license.md)
- [Mechanical & Packaging](https://docs.omi.me/doc/hardware/consumer/mechanical.md)
- [OmiGlass Hardware & Assembly](https://docs.omi.me/doc/hardware/omiGlass.md)
- [OmiGlass Flash Firmware](https://docs.omi.me/doc/hardware/omiglass/flash-firmware.md)
- [Disclaimer](https://docs.omi.me/doc/info/Disclaimer.md)
- [License](https://docs.omi.me/doc/info/License.md)
- [Privacy Policy](https://docs.omi.me/doc/info/Privacy.md)
- [Support](https://docs.omi.me/doc/info/Support.md)
- [Integrate 3P Wearables](https://docs.omi.me/doc/integrations.md): A guide to integrating any wearable device, like Plaud, Limitless, or your own custom hardware, with the Omi open-source ecosystem.
- [Get Started with Omi](https://docs.omi.me/getstartedwithomi.md)

## OpenAPI Specs section (verbatim, 5 links)
- [app-client-openapi](https://docs.omi.me/api-reference/app-client-openapi.json)
- [openapi](https://docs.omi.me/api-reference/openapi.json)
- [integration-public-openapi](https://docs.omi.me/api-reference/integration-public-openapi.json)
- [package](https://docs.omi.me/package.json)  <- Mintlify site's own npm manifest, noise
- [package-lock](https://docs.omi.me/package-lock.json)  <- noise

For a client implementation, the three real OpenAPI specs (`openapi.json`, `integration-public-openapi.json`, `app-client-openapi.json`) are the machine-readable ground truth to fetch next.

## Notable pages NOT in our expected list
- `doc/developer/backend/listen_pusher_pipeline.md` — documents a `/v4/listen` WebSocket (real-time listen pipeline).
- `doc/developer/backend/transcription.md` — WebSocket connections, STT providers, message formats, building external custom STT services.
- `doc/developer/cli/*` — an `omi-cli` with a stable agent contract (JSON output, exit codes) and auth via browser OAuth or dev API key.
- `doc/developer/mcp/*` — an official Omi MCP server.
- `api-reference/goals/*` and `api-reference/developer/search-memories-vector.md` — Goals CRUD + vector memory search, beyond the memories/conversations/action-items set in our spec.
- There is no page titled "chat API" per se; chat-related developer surface = `doc/developer/apps/ChatTools.md` (custom chat tools) and `doc/get_started/chat_tips.md` (user-facing).
