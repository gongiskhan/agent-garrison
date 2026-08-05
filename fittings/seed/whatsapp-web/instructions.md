# WhatsApp Web — one-time setup

whatsapp-web gives the Operative a personal WhatsApp channel over the
WhatsApp Web protocol (via `@whiskeysockets/baileys` — a direct WebSocket
client, no browser/Chromium, no WhatsApp Business Cloud API). The Fitting
itself is automated (`scripts/setup.sh` installs deps and prepares the
session directory on every `up`); pairing your account is a deliberate,
one-time manual step you do yourself. Garrison never does it for you.

## 1. Start the daemon

whatsapp-web is `own_port`, non-eager by default — it does not auto-start
with the Operative until you've paired an account. Start it once from
Garrison's **Views** sidebar (WhatsApp -> Start), or by hand from the
Fitting's installed directory:

```sh
node apm_modules/_local/whatsapp-web/scripts/start.mjs
```

Confirm it's up:

```sh
curl http://127.0.0.1:7080/health
# { "ok": true, "paired": false, "connected": false, ... }
```

(Port 7080 is the default; check `~/.garrison/ui-fittings/whatsapp-web.json`
for the actual port if you changed it in Compose.)

## 2. Pair with a code (headless — no QR)

This machine is normally accessed over SSH, so QR-code pairing (which needs a
camera pointed at a screen) isn't practical. Baileys also supports **pairing
by code**, which you type into your phone instead:

```sh
node apm_modules/_local/whatsapp-web/scripts/pair.mjs +351912345678
```

Use your own number, full international format (a leading `+` is fine — it's
stripped along with spaces/dashes; only the digits matter). This prints an
8-character pairing code.

On your phone:

1. Open **WhatsApp** -> **Settings** (or the three-dot menu) -> **Linked
   Devices**.
2. Tap **Link a Device**.
3. Tap **Link with phone number instead** (near the bottom of the QR screen).
4. Enter the code printed above. You have about 60 seconds before it
   expires — if it does, just run `pair.mjs` again for a fresh one.

Once linked, the daemon's Baileys session state (keys, not your messages) is
written to `session_dir` (default `~/.config/garrison/whatsapp-web/auth/`,
mode `0700`/`0600`) — **not** the Garrison Vault, and **not** under
`apm_modules/` (which gets rebuilt/wiped on every `apm install`). Losing
that directory means re-pairing from scratch; back it up like any other
credential if you care about avoiding a re-pair.

Check `/health` again — `paired` and `connected` should now both be `true`.

## 3. Try it

From the Operative (or by hand):

```sh
node apm_modules/_local/whatsapp-web/scripts/connector.mjs call resolve_contact '{"name":"Maria"}'
# {"ok":true,"result":[{"name":"Maria Silva","jid":"351912345678@s.whatsapp.net"}]}

node apm_modules/_local/whatsapp-web/scripts/connector.mjs call send_text \
  '{"to":"351912345678@s.whatsapp.net","body":"On my way"}'
```

`send_text` only ever accepts an exact WhatsApp JID (the `.../@s.whatsapp.net`
or `.../@g.us` form `resolve_contact` returns) — never a bare name. This is
enforced in code, not just documented: a name, a phone number without the
`@s.whatsapp.net` suffix, or anything else that doesn't match
`/^\d+@(s\.whatsapp\.net|g\.us)$/` is rejected before anything reaches the
socket.

## What the Operative can do with this Fitting

- **"Send a message to X saying Y"** — the Operative calls `resolve_contact`,
  shows you the candidates, and only calls `send_text` with the jid you
  confirm. It should never guess a jid on its own, and the connector rejects
  a bare name outright even if it tried.
- **"What was the last message I received on WhatsApp"** — `last_message` /
  `recent_messages` read the local store; no live WhatsApp round-trip.

## Message history limitation

Baileys does **not** backfill history from before it first connects. The
local message store (`session_dir/messages.jsonl`) only ever contains
messages seen from the moment you pair onward — "what was my last message
from Maria" will come back empty until Maria (or you) sends something after
this setup.

## Sending is deliberately narrow

- `send_text` sends exactly one message per call — there is no batch-send
  action anywhere in this Fitting.
- Every send is paced with a small randomized delay (`min_send_delay_ms` /
  `max_send_delay_ms` in Compose, default 1.2–3.5s) and serialized through one
  queue, so nothing can burst multiple messages back to back even if asked to.
- `send_text` is **not reachable from the Automations engine** — a scheduled
  or "run now" automation step against this connector can read
  (`resolve_contact`, `recent_messages`, `last_message`) but any attempt to
  call `send_text` from that path is refused outright, unconditionally, before
  any network call happens. Only a direct call in a live conversation with you
  can send.

## Troubleshooting

- **`awaiting_connector: true` on any call** — the daemon isn't running, or
  isn't paired yet. Check `/health`.
- **Pairing code expires before you enter it** — just run `pair.mjs` again;
  each call requests a fresh code.
- **Logged out remotely (unlinked from the phone)** — the daemon detects this
  on its next reconnect attempt and stops trying; `/health` reports
  `paired: false`. Re-pair with `pair.mjs`.
- **Session lost after wiping `~/.config/garrison/whatsapp-web/`** — that's
  the only durable copy of the credentials; there is nothing to recover, just
  re-pair.
