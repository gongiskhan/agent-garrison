# Capture service — human setup

Everything the run could not do itself. In order; each step says how to
verify it landed. The fitting ships inert (every flag off) — nothing here
turns anything on until the flags do.

## 1. Seal the vault secrets

Open `/vault` on the prod shell and add:

- `CAPTURE_TOKEN` — mint it yourself: `openssl rand -hex 24`. This is the
  Bearer token the phone presents; it goes into the app's Settings in step 5.
- `DEEPGRAM_API_KEY` — does not exist yet anywhere (verified against the
  vault on 2026-08-13): create an API key at console.deepgram.com (any
  project, default scopes). Without it sessions store media but no
  transcripts (`transcribe_skipped` counts on /health).
- `APNS_TEAM_ID` — `N3AN3Z32JN` (the Apple team; recorded from ios-thing's
  deployment).
- `APNS_KEY_ID` + `APNS_P8` — an APNs AUTH KEY (NOT the App Store Connect
  API key). The team already has one from the RemoteThing era, id
  `JUJBGTKB6F`, whose .p8 lives on the mac-mini at
  `~/.config/remotething/` — paste its CONTENT (the whole PEM, BEGIN/END
  lines included; base64 also accepted) as `APNS_P8` and `JUJBGTKB6F` as
  `APNS_KEY_ID`. If that file is lost, mint a new key in the Developer
  portal (Certificates, Identifiers & Profiles -> Keys -> "+", enable APNs)
  — new keys download once, seal immediately.

Then flip the composition flags you want (Compose -> capture-service):
`enabled`, `transcribe_enabled`, `wake_enabled`, `notify_enabled`,
`speak_enabled` — and `up`. Verify: `/health` on the fitting shows every
secret `true` and the flags you enabled.

## 2. The five browser minutes the APIs refuse to do (one time)

The lane automated everything token auth allows (App IDs registered, Push +
App Groups capabilities enabled, certificates and profiles from match, build
and upload plumbing — all proven green up to these gates). Three portal
items have NO API (verified empirically; run 31665927532 returned the whole
capability enum):

a. **App record** — appstoreconnect.apple.com -> My Apps -> "+" -> New App:
   platform iOS, name **Garrison**, language English, bundle id
   **com.gomes.garrison** (already in the dropdown), SKU `com.gomes.garrison`.
b. **App Group** — developer.apple.com -> Certificates, Identifiers &
   Profiles -> Identifiers -> "+" -> App Groups: identifier
   **group.com.gomes.garrison**, description "Garrison". Then open EACH of
   the two App IDs (`com.gomes.garrison`, `com.gomes.garrison.broadcast`)
   -> App Groups capability -> Configure -> tick group.com.gomes.garrison.
c. **Time Sensitive Notifications** — still in `com.gomes.garrison`'s
   capability list: tick Time Sensitive Notifications. Save.

Verify: both identifier pages show App Groups (configured) and the host
shows Time Sensitive Notifications.

## 3. Ship the TestFlight build

```bash
# first build after step 2 (regenerates profiles with the new capabilities):
gh workflow run garrison-ios.yml -R gongiskhan/ios-thing -f lane=beta -f match_force=true
# every later build:
gh workflow run garrison-ios.yml -R gongiskhan/ios-thing -f lane=beta
```

(The workflow lives in the PRIVATE ios-thing repo because that is where the
signing secrets and match storage are; agent-garrison is public.) Verify:
the run goes green and the build appears in App Store Connect -> TestFlight
-> iOS builds ("Processing" for a few minutes first). Add yourself as an
internal tester on the TestFlight tab once, then install from the TestFlight
app on the phone.

## 4. Install Tailscale on the iPhone

App Store -> Tailscale -> sign in to the tailnet (same account as
dev-madrid). Verify: Safari on the phone opens
`https://dev-madrid.tail31efa.ts.net:8498/health` (the capture service's
tailnet serve mapping; prod publishes it on redeploy) and shows `ok: true`.

## 5. Point the app at Garrison

Garrison app -> Settings:

- Base URL: `https://dev-madrid.tail31efa.ts.net:8498`
- Capture token: the `CAPTURE_TOKEN` value from step 1
- Device name: whatever you like
- Tap "Test connection" -> "Connected."
- Tap "Register for push" and accept the notification prompt -> status
  "registered". Verify server-side: `devices_registered` on /health.

## 6. First run and the consent sheet

Tap "Start audio session". The consent notice appears — "If you have people
around, always ask for consent." — with a "Don't ask me again" checkbox.
Whichever you choose travels with every session as `consent: shown` or
`consent: suppressed` in the capture event's provenance; the toggle can be
reversed later in Settings.

## 7. The spoken smoke test

Start an audio session and say, naturally:

> "Zeca, cria uma tarefa de teste chamada olá companion."

(or the English fixture phrase: "Zeca, create a test task called hello
companion."). Then stop the session. Expected, with rough timings:

- **Live transcript** appears on the fitting's session page within ~2s of
  speech (open the session from the app's Sessions screen).
- **Wake**: `wake_hits` 1 within ~5s of the sentence ending (punctuated
  finals close the capture early); `wake_capture_ms` shows that leg.
- **Card**: on the Kanban backlog within ~12s of speaking (capture +
  pinned classify ~6s + write), origin `companion`, provenance in the body.
- **Push**: the confirmation buzzes the phone (`notifications_sent` 1); in
  a live audio session with `speak_enabled` on, the phone SPEAKS the
  confirmation instead (`speaks_forwarded`/`speaks_confirmed` 1) and the
  push is not doubled for the same event.
- **Echo**: the spoken confirmation must NOT reappear as a card or in the
  transcript (`realtime_echo_suppressed` counts it).
- **Triage**: after session end, the next tick (5-minute cron on prod)
  turns the session into cards/memories — wait out the full period before
  reading anything as failure. `events_emitted` then the session event
  `triaged`; the memory lands in the Obsidian vault under `Memory/` with a
  `companion-` prefix.

## 8. Asks, and answering by voice

An `ask` arrives as a push (full question in the notification body; also in
the app's Messages log). Answer by voice in any live session — "Zeca, ..."
— or via Omi; the orchestrator receives recent-ask context so the answer
lands connected. There is no reply protocol in v1, by design.
