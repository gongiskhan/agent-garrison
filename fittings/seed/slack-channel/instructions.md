# Slack channel — one-time setup

Steps the principal runs once to wire a Slack workspace into the
Operative. The Fitting itself is automated; these are the manual
prerequisites.

## 1. Create a Slack app

1. Go to <https://api.slack.com/apps> and click **Create New App** →
   **From scratch**.
2. Name the app (e.g. "Garrison Operative") and pick the target
   workspace.

## 2. OAuth scopes

Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**,
add:

- `chat:write` — post replies.
- `app_mentions:read` — receive `app_mention` events.
- `im:history` — read DM contents.
- `groups:history` — read private channels the bot is added to.
- `channels:history` — read public channels the bot is added to.

Click **Install to Workspace** and copy the **Bot User OAuth Token**
(`xoxb-...`).

## 3. Signing secret

Under **Basic Information** → **App Credentials**, copy the
**Signing Secret**.

## 4. Drop credentials in the vault

Open Garrison's **Vault** tab and add:

- `SLACK_BOT_TOKEN` → the `xoxb-...` token from step 2.
- `SLACK_SIGNING_SECRET` → the secret from step 3.

The Fitting's setup hook reports a readiness warning while either value is
missing, but it does not block the rest of the composition (for example, a Web
channel remains usable). Slack stays inactive until both values exist. Starting
the Slack adapter without them fails immediately with a clear error.

## 4b. Pick where proactive messages land (optional)

Set the Fitting's **notify_channel** config (or `SLACK_NOTIFY_CHANNEL` in the
adapter's environment) to the conversation Garrison should post reminders and
board notices into:

- a channel id (`C…`) the bot is a member of,
- a DM id (`D…`),
- or your own user id (`U…`) - `chat.postMessage` delivers that as a DM.

Copy the id from Slack via **View channel details** (bottom of the dialog) or a
member's profile → **Copy member ID**.

Leave it unset and Slack still answers every message and still posts card
outcomes into the thread that asked for them; only the channel-wide
notifications (`POST /notify`) have nowhere to go, and the adapter says so
instead of pretending to have delivered.

## 5. Expose the adapter to Slack

Slack's Events API needs to reach the local adapter (default port
29512) over HTTPS. Easiest options:

- **Cloudflare Tunnel** (recommended for v1):
  ```sh
  cloudflared tunnel --url http://127.0.0.1:29512
  ```
  Cloudflare prints a public `https://<random>.trycloudflare.com`
  URL.

- **Tailscale Funnel** if your machine is in your tailnet.

- **ngrok** if you'd rather pay a flat fee.

The setup hook prints the cloudflared invocation if `cloudflared`
is on PATH.

## 6. Point Slack at the public URL

In the Slack app, go to **Event Subscriptions** → **Enable Events**:

- **Request URL:** `https://<your-tunnel-host>/slack/events`.
  Slack does a `url_verification` round-trip; the adapter handles
  it automatically.
- **Subscribe to bot events:**
  - `app_mention`
  - `message.im`

Save changes. Reinstall the app to the workspace if Slack prompts.

## 7. Test

In a channel where the bot is a member, mention it:

```
@Garrison Operative ping
```

Or DM the bot directly. The reply lands threaded under your message.

## 8. What comes back on its own

Once the adapter is running, Slack is a two-way channel:

- **Replies** land threaded under the message that asked for them (as before).
- **Card outcomes** land in that same thread. A Slack message that becomes a run
  is stamped with the origin `slack:<conversation>:<thread_ts>`, so "Run complete",
  "Needs attention", brief and needs-input messages all come back where the
  conversation started - no configuration involved.
- **Notifications** (scheduled cards coming due, board notices) go to
  `notify_channel` from step 4b. They carry the card link; action buttons render
  as links because this adapter has no Slack interactivity endpoint yet.

Both are plain HTTP on the adapter's loopback port:

| Route | Purpose |
| --- | --- |
| `POST /notify` | `{title, text, actions[], link, tag, idempotencyKey}` fan-out |
| `POST /api/threads/<id>/messages` | `{messages:[{role,text}], idempotencyKey}` thread append |

Garrison finds them through the status file the adapter writes on start,
`~/.garrison/ui-fittings/slack-channel.json` (removed on shutdown). If proactive
messages are not arriving, check that file exists and names the running pid.

A repeated `idempotencyKey` is delivered once: the adapter keeps a bounded,
24-hour dedupe record under `~/.garrison/slack-channel/notify-dedupe.json`, so a
re-fanned reminder does not post twice - including across an adapter restart.

## 9. The send buffer (agent-triggered messages)

- **A send the agent triggers is parked, not sent.** `send_message` from an
  agent or automation context goes into the adapter's outbox with a 60-second
  cancel window and only reaches Slack when that window elapses uncancelled,
  so an irreversible action stays takeable-back for a minute. The call answers
  `{queued: true, id, executeAt}` and says plainly it has NOT sent yet.
- `GET /outbox` lists what is parked; `POST /outbox/<id>/cancel` takes one back
  (idempotent, and honest about "already sent" once the window has passed).
- Several parked messages for the same destination that come due together are
  batched into ONE Slack post - kinder to the reader and to Slack's ~1
  message/second/channel limit. A lone message arrives verbatim.
- A restart inside the window re-arms what is still parked; anything a crash
  caught mid-send is failed rather than sent twice.
- A send you make yourself from a UI bypasses the buffer
  (`GARRISON_SEND_CONTEXT=human`).

## Troubleshooting

- **401 bad signature** — system clock drift. The adapter rejects
  requests older than 5 minutes.
- **No reply** — check the gateway is up (`curl
  http://127.0.0.1:24777/health` returns `ok`).
- **Reply takes minutes** — long tool-using turns can; the gateway
  serializes turns through its `inflight` chain, so concurrent
  Slack messages will queue.
