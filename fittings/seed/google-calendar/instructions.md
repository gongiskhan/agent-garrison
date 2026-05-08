# Google Calendar Fitting — Setup Guide

This Fitting is opt-in: it requires a one-time interactive OAuth
consent. To enable it on a new machine:

## 1. Create a Google OAuth Desktop client

1. Go to <https://console.cloud.google.com/>.
2. Create a project (or pick an existing personal-use project).
3. Enable the **Google Calendar API** for that project (APIs &
   Services → Library → "Google Calendar API" → Enable).
4. Configure the **OAuth consent screen** (APIs & Services → OAuth
   consent screen):
   - User type: **External**.
   - App name: e.g. "Garrison".
   - Support / developer email: your address.
   - Add yourself as a **Test user** (you can leave the app in
     Testing mode — no verification required for personal use).
5. Create the **OAuth client** (APIs & Services → Credentials →
   Create Credentials → OAuth client ID):
   - Application type: **Desktop app**.
   - Name: "Garrison Calendar".
6. Copy the **Client ID** and **Client secret** Google shows you.

## 2. Store the credentials in the Garrison vault

Open Garrison's **Vault** tab and add:

- `GOOGLE_OAUTH_CLIENT_ID` → the client ID from step 1
  (looks like `xxxxx.apps.googleusercontent.com`).
- `GOOGLE_OAUTH_CLIENT_SECRET` → the client secret from step 1
  (looks like `GOCSPX-xxxxx`).

The runner injects these into the Fitting's environment at
composition startup; the Fitting itself never writes them to disk.
The Fitting's setup hook checks both are present before running
the OAuth flow.

## 3. Opt the Fitting in to your composition

Edit your composition's `apm.yml` and add `google-calendar` to the
`automations` selection block:

```yaml
selections:
  automations:
    - id: browser-automation
      config:
        browser: chromium
        headless: false
    - id: google-calendar
      config:
        calendar_file: data/calendar.md
        sync_cron: "*/5 * * * *"
```

## 4. First run

```bash
garrison up
```

On the first run the setup script opens a browser tab pointing at
Google's OAuth consent page. Approve the requested scope
(`https://www.googleapis.com/auth/calendar` — read+write). The
local loopback server captures the redirect and persists the
refresh token at `~/.garrison/google-calendar/token.json` (mode
0600).

Subsequent `garrison up` invocations refresh the token silently —
no browser tab.

If the scheduler Fitting is also selected in your composition, the
setup registers a `calendar-sync` job that runs every 5 minutes
and overwrites `<composition-dir>/data/calendar.md`.

## 5. Token revocation

If you want to revoke Garrison's access:

1. Delete the local token: `rm ~/.garrison/google-calendar/token.json`.
2. Optional: revoke on Google's side at
   <https://myaccount.google.com/permissions>.
3. Re-run `garrison up` to authorize again (or remove the Fitting
   from your composition selections).

## 6. Verifying

```bash
bash apm_modules/_local/google-calendar/scripts/verify.sh
# expects: ok
```

```bash
uv run --directory apm_modules/_local/google-calendar \
  python scripts/calendar.py list today
# returns JSON array of today's events
```
