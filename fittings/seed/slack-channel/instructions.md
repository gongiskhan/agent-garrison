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

## Troubleshooting

- **401 bad signature** — system clock drift. The adapter rejects
  requests older than 5 minutes.
- **No reply** — check the gateway is up (`curl
  http://127.0.0.1:24777/health` returns `ok`).
- **Reply takes minutes** — long tool-using turns can; the gateway
  serializes turns through its `inflight` chain, so concurrent
  Slack messages will queue.
