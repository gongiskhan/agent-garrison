# WhatsApp Web — one-time setup

whatsapp-web gives the Operative a personal WhatsApp channel over the
WhatsApp Web protocol (via `@whiskeysockets/baileys` — a direct WebSocket
client, no browser/Chromium, no WhatsApp Business Cloud API). The Fitting
itself is automated (`scripts/setup.sh` installs deps and prepares the
session directory on every `up`); pairing your account is a deliberate,
one-time manual step you do yourself. Garrison never does it for you.

## 1. Start the daemon

whatsapp-web is `own_port`, so the daemon starts with the Operative on `up`
and stops on `down` — paired or not (unpaired it simply serves `/health` and
the pairing page). If it isn't up, start it from Garrison's **Views** sidebar
(WhatsApp -> Start), or by hand from the Fitting's installed directory:

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

## 2. Pair the account (QR, from the Fitting's own page)

The daemon serves a small pairing page on its own port. Open **Views ->
WhatsApp** in Garrison (or `http://127.0.0.1:7080/` on the host itself) and
click **Pair with a QR code instead**. Then, on your phone:

1. Open **WhatsApp** -> **Settings** (or the three-dot menu) -> **Linked
   Devices**.
2. Tap **Link a Device**.
3. Point the camera at the QR on the page.

The page re-fetches the code every 5 seconds for as long as the socket keeps
emitting one, so a QR that expires while you are still finding the menu heals
itself — nothing to restart.

**QR is the pairing path that works.** `scripts/pair.mjs <number>` (pairing by
8-character code) is still in the tree and still prints a code, but in practice
WhatsApp tears the socket down within a fraction of a second on that path, and
a failed attempt leaves half-written credentials in `session_dir/auth/` that
make the *next* attempt fail the same way. If you tried it and got stuck,
delete `~/.config/garrison/whatsapp-web/auth/` before pairing again by QR.

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
- **A send the agent triggers is parked, not sent.** It goes into the daemon's
  outbox with a 60-second cancel window and only reaches WhatsApp when that
  window elapses uncancelled, so an irreversible action stays takeable-back for
  a minute. The call answers `{queued: true, sent: false, id, executeAt}`.
  `GET /outbox` lists what is parked; `POST /outbox/<id>/cancel` takes one
  back (idempotent, and honest about "already sent" once the window has
  passed). A restart inside the window re-arms what is still parked; anything a
  crash caught mid-send is failed rather than sent twice. A send you make
  yourself from a UI bypasses the buffer (`GARRISON_SEND_CONTEXT=human`).

## Troubleshooting

- **`awaiting_connector: true` on any call** — the daemon isn't running, or
  isn't paired yet. Check `/health`.
- **The QR expires while you are on the phone** — the page re-fetches it
  every 5 seconds; scan whichever one is on screen.
- **`paired` never flips to true and the log shows the socket closing at once**
  — an earlier pairing-by-code attempt has poisoned `session_dir/auth/`.
  Delete that directory and pair by QR.
- **Logged out remotely (unlinked from the phone)** — the daemon detects this
  on its next reconnect attempt and stops trying; `/health` reports
  `paired: false`. Re-pair by QR from the Fitting's page.
- **Session lost after wiping `~/.config/garrison/whatsapp-web/`** — that's
  the only durable copy of the credentials; there is nothing to recover, just
  re-pair.
