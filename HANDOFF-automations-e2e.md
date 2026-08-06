# Handoff — Garrison to Cortex automations, end to end

What this proves: a user-scoped API key minted in Ekoa lets the Garrison automations
fitting drive the **public Cortex capability API** — list integrations, execute an
action, start a run and follow it — with the Google credential held by Cortex and
never seen by Garrison.

Everything below was exercised against a live stack on `dev-madrid` except the three
steps marked **HUMAN** — those need your browser or your Google Cloud console, and
they are prepared to the last click.

Read [What is actually true](#what-is-actually-true-corrections-to-the-brief) before
the steps: three assumptions in the original brief turned out to be wrong, and one of
them changes which action you should run first.

---

## 1. HUMAN — register the redirect URI in Google Cloud Console

Cortex builds its Google redirect URI as `${OAUTH_REDIRECT_BASE_URL}/api/v1/oauth/google/callback`
(`api/src/integrations/platform-oauth.ts`, `redirectUri()`). With the stack published on
the tailnet at port 4111, the value to add is exactly:

```
https://dev-madrid.tail31efa.ts.net:4111/api/v1/oauth/google/callback
```

Add it to the **same** OAuth web client Garrison already uses — the one whose id and
secret are in the Garrison Vault as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
That client already has `https://dev-madrid.tail31efa.ts.net/api/connectors/google/oauth-callback`
registered and working, which is how we know Google accepts a `.ts.net` HTTPS redirect
for it. Adding a second URI to an existing client is additive and does not disturb
Garrison's own connection.

Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Web client →
**Authorised redirect URIs** → Add URI → paste → Save. Changes can take a few minutes
to propagate.

The scopes Cortex requests are fixed in `GOOGLE_SCOPES` (same file): `openid`, `email`,
`profile`, `gmail.modify`, `calendar`, `drive`, `spreadsheets`, `documents`, `tasks`.

## 2. HUMAN — publish the stack on the tailnet

I could not run these (changing network exposure is blocked for me), and without them
your browser cannot reach the stack and Google cannot reach the callback:

```bash
tailscale serve --bg --https=4111 http://127.0.0.1:4111   # the API + its OAuth callback
tailscale serve --bg --https=3000 http://127.0.0.1:3000   # the dashboard
```

Both are tailnet-only, not funnel. Verify with `tailscale serve status`.

## 3. Start the stack

```bash
cd ~/dev/ekoa-code
npm run build --workspace shared && npm run build --workspace api

EKOA_DEV_DB_PATH="$HOME/.ekoa/dev-db" \
OAUTH_REDIRECT_BASE_URL="https://dev-madrid.tail31efa.ts.net:4111" \
EKOA_PUBLIC_API_URL="https://dev-madrid.tail31efa.ts.net:4111" \
EKOA_PUBLIC_WEB_HOST="dev-madrid.tail31efa.ts.net" \
GOOGLE_CLIENT_ID="<the same client id as the Garrison vault holds>" \
GOOGLE_CLIENT_SECRET="<the same client secret>" \
node .claude/skills/run-ekoa-code/driver.mjs up
```

Three of those env vars are new and exist because of this work:

- `EKOA_DEV_DB_PATH` makes the dev database **survive a restart**. It used to be a fresh
  ephemeral Mongo every boot, which meant redoing the Google consent screen on every
  restart. Verified: minted a key, restarted the whole stack, the same key still
  authenticated and the same automations were still there.
- `EKOA_PUBLIC_API_URL` is the origin baked into the web bundle **and its CSP**. Without
  it the bundle points at `http://localhost:4111`, which your laptop cannot resolve, and
  the login fetch is blocked with nothing in the server log.
- `EKOA_PUBLIC_WEB_HOST` lets Next accept the dashboard being reached over a hostname
  other than localhost.

If you want the natural-language lane (`achieve`, and `plan`), also provision the model
credential — `npm run dev` does it automatically, or run
`node scripts/dev-credential.mjs --no-browser --provision` once the stack is up. The
deterministic execute path used in step 7 does **not** need it.

## 4. HUMAN — connect Google in Ekoa

Open `https://dev-madrid.tail31efa.ts.net:3000`, sign in (`admin` / `tmp12345` on this
dev stack), then:

**Integrações → the "Plataforma" tab → the Google Workspace card → Ligar.**

A popup goes to Google, you pick the account and consent, and the callback page posts the
result back and closes itself. The card should then show "Ligado" with the account email.

The connect button is org-admin only; `admin` is super-admin, so it is available.

## 5. Create the user-scoped API key

**Definições → Chaves de API → create one.** The secret is shown **exactly once** and is
never retrievable again — copy it now. It looks like `ekoa_gk_…`.

Equivalent on the command line, if you prefer:

```bash
TOKEN=$(curl -s -X POST http://localhost:4111/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"tmp12345"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s -X POST http://localhost:4111/api/v1/gateway-keys \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"label":"garrison"}'
```

The key carries exactly its user's tenant and access, and nothing more — verified live:
with the key, `/api/v1/gateway-keys`, `/api/v1/users` and `/api/v1/cofre/items` all
answer 401, while the capability routes answer normally.

## 6. Paste the key into Garrison

The key is already in the prod Vault as `CORTEX_API_KEY` — I minted one and wrote it there.
The fitting is **not** equipped, and that part is yours to do:

1. **Vault** (`https://dev-madrid.tail31efa.ts.net/vault`) — `CORTEX_API_KEY` is already set.
   It belongs to the dev stack's `admin`; mint your own and replace it if you want the calls
   under your own identity.
2. **Compose** → equip **cortex-automations** → set its `base_url` to `http://127.0.0.1:4111`
   (loopback is correct here: Garrison calls Cortex server-to-server on the same box, and the
   browser never sees this value. Do not put a loopback URL anywhere the browser consumes.)
3. The **Session** view then appears under Fittings.

I did equip it in `compositions/default/apm.yml` while proving the chain, and then reverted
it, because the fitting's own suite asserts that no `compositions/default*` composition may
station it — the shipped default is shared by every user of this repo and the Fitting is
meant to arrive inert. Equipping it is a per-user choice, not a default. (`dogfood-dev`
already has it, if you would rather use that composition than edit `default`.)

The key is read server-side only. Garrison's proxy (`src/lib/cortex-proxy.ts`) attaches it
and holds it to a closed allowlist of the public endpoints; neither the key nor the base
URL is ever sent to the browser.

**One hazard while you are in the Vault UI**: `PUT /api/vault/secrets` rebuilds the secret
list from exactly what you send. A key you omit is DROPPED, not left alone — the route's own
comment ("undefined/null/missing all mean unchanged") is about a missing *value*, not a
missing *key*. A partial write would have silently destroyed the other 14 secrets. I wrote
`CORTEX_API_KEY` by listing all 14 existing key names with no value (which does mean
"unchanged") plus the new one, and verified afterwards that all 15 were present. The UI does
the right thing; a script might not.

## 7. Run the first session

In the Session view, pick **google-workspace** and execute **`list_files`** (Drive) or
**`list_labels`** (Gmail). Both are read-only, so neither touches the write gate.

Expected before you connect Google: `{"success": false, "code": "not_connected"}` at
HTTP **200**. Expected after: `success: true` with the Drive/Gmail payload.

Do not start with a write action. See the write-gate note below for why.

**What I already drove through the whole chain**, so you know exactly which link is
untested. Garrison view → Garrison proxy (vault key attached) → Cortex public API (key
auth) → action resolution → Google:

| through the Garrison proxy | result |
|---|---|
| `GET /api/v1/integrations` | HTTP 200, 11 integrations |
| `POST …/google-workspace/actions/list_files/execute` | HTTP 200 `{"success": false, "code": "not_connected"}` |
| `POST …/actions/send_email_simple/execute` | HTTP 403 `awaiting_consent`, target `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, no placeholder |
| `GET /api/v1/cofre/items` | HTTP 400, refused by the proxy allowlist |
| `GET /api/v1/gateway-keys` | HTTP 400, refused by the proxy allowlist |

So every link is proven except the Google grant itself. `not_connected` is precisely the
"everything works, nobody has consented yet" state — after step 4 that same call returns
your Drive files.

---

## What is actually true (corrections to the brief)

**Google Workspace is not a CLI integration and needs no bridge.** It is an OAuth2 HTTP
integration with 24 actions, every one of them an `httpConfig` against `googleapis.com`
(`GET`/`POST` to gmail, drive, calendar, sheets, docs, tasks). Nothing in it routes to the
Cortex bridge, so the whole "a bridge must be alive on some machine" prerequisite does not
apply to this path. `/health` reports `bridgeConnections: 0` on this box and that is fine.

**The Google credential does not live in the Cofre.** It is an org-scoped, envelope-encrypted
token bundle on an `integrationConfigs` row (`platform-<orgId>-google`), decrypted and
refreshed on expiry by `getValidPlatformTokens` with a singleflight so a rotating refresh
token is never double-spent. The Cofre (`/api/v1/cofre/*`) is a separate store and is **not
reachable with a capability key at all** — every cofre endpoint is `auth: 'user'`, so it is
absent from the key-reachable OpenAPI surface by construction.

**The consent-placeholder defect is already fixed, and I confirmed it live.** Executing a
mutating action with a real key returns HTTP 403 naming the **resolved** destination:

```
POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
```

no `{{placeholder}}`. The gate also fires *before* the not-connected check, so it answers
before any credential is touched.

**A write started from a key cannot be approved by that key.** The 403 carries a
`consentRequest` descriptor so the client can show what is being asked, but the approval
endpoint (`POST /api/v1/integrations/:key/actions/:name/approval`) is `auth: 'user'` and is
deliberately not on the key-reachable surface. A human approves it in the Ekoa UI. This is
by design, and it is why the first run should be read-only.

A **run** that parks on a consent gate is different — that one the key *can* answer, via
`POST /api/v1/automations/runs/{id}/consent`. It could not before this session; see below.

**There is no event stream on the key-reachable surface.** Run status is polled. Nothing in
the UI should call itself live.

---

## What I fixed

**ekoa-code**

- `api/src/automation/service.ts` + `shared/src/automations.ts` + regenerated
  `docs/openapi/cortex.v1.json` — **a parked run now publishes the question it is asking.**
  `POST /runs/{id}/consent` is `user-or-key` and its body *requires* the exact `shape` the
  run awaits, but the only carrier of that shape was an SSE event, and no event stream is
  key-reachable. So an external client could read `status: "awaiting_consent"` and had no
  published way to learn what was being asked or which shape to echo back — an endpoint
  whose auth class invites a caller who could not use it. `RunRecord` now carries
  `consentRequest: {stepIndex, description, shape}`. The raw `argv` and the server-written
  `approvalScope` stay off the wire. Covered by a test that drives the whole loop using only
  the wire record, verified red without the fix.
- `api/src/automation/service.ts` — **`POST /automations` no longer stores a step it cannot
  run.** The wire step reaches the service as `{stepId, description, tool}` and every other
  field was discarded, so an `integration` step authored through the public API lost its
  `integrationKey`/`integrationAction` and failed at run time with
  `missing integrationKey or integrationAction` — blaming the caller for fields the API
  itself dropped. It now refuses at the door, naming the fields that cannot be expressed and
  pointing at `POST /automations/plan`, which is the supported route for those steps. An
  unrecognised `tool` is also refused instead of being silently coerced to `browser`.
  **Deliberately not done:** widening the mapper to carry those fields. Engine steps also
  carry `commandTemplate`, `apiRequest` and the `declaration` that governs where a step runs
  and which Cofre items it may reference — widening would hand every key holder those
  authoring powers. That is your call, not a mapper detail; it is logged OPEN in
  `docs/findings.md`.
- `api/tests/security/cofre-not-key-reachable.test.ts` (new) — pins the Cofre off the
  capability surface, at two altitudes: no cofre descriptor may declare `user-or-key`, and a
  real minted key is refused by every cofre route with the byte-identical envelope an
  anonymous caller gets. Verified red by planting `user-or-key` on one descriptor.
- `scripts/dev-api.mjs` — the dev database can persist (`EKOA_DEV_DB_PATH`), and a pre-set
  `MONGODB_URI` is now honoured instead of being overwritten. Default is unchanged: ephemeral.
- `web/next.config.ts` — one API-URL resolver for both the bundle and the CSP. They were
  computed differently (`resolveApiUrl()` vs a raw env read), so the CSP could name a
  different origin than the app calls and the browser would block the login fetch with
  nothing in the log. Adds the `EKOA_PUBLIC_API_URL` / `EKOA_PUBLIC_WEB_HOST` escapes.
- `.claude/skills/run-ekoa-code/driver.mjs` — stops overwriting the public API origin with a
  loopback one.
- `clients/cortex-cli` — new `integrations` command group (`list`, `show`, `execute`,
  `achieve`). The CLI covered memory, knowledge and automations but not integrations, even
  though integrations is on the published surface. It treats an HTTP 200 with
  `success: false` as a failure, and surfaces the `awaiting_consent` descriptor intact.

**garrison**

- `fittings/seed/cortex-automations` — a third view, **Session**: settings for the origin and
  the key's presence, an integrations pane that executes an action, and a runs pane that
  starts a run and polls it to a conclusion, showing per-step status, errors and screenshots,
  and answering a consent or pause inline.
- `src/lib/cortex-proxy.ts` + `src/app/api/cortex/` — the server-side proxy, closed to an
  allowlist of the public endpoints, so the key stays server-side and the browser only ever
  talks to Garrison.

## Open, unverified, or flaky

- **The Google leg is not proven end to end.** I verified everything on both sides of the
  consent screen — the authorize-URL construction, the CSRF state with its TTL, the token
  exchange, the encrypted persistence, refresh-on-expiry, and that `list_files` reaches
  exactly `not_connected` — but consenting needs your Google session. The suite covering that
  chain (`api/tests/integrations/platform.test.ts`, 15 tests) is green.
- **The Ekoa deploy config would not configure Google today.** `deploy/api.service.json` and
  `ekoa-deploy`'s `services/cortex/deploy.json` pass `EKOA_OAUTH_REDIRECT_BASE_URL`, but the
  code reads `OAUTH_REDIRECT_BASE_URL`, and neither list passes `GOOGLE_CLIENT_ID` or
  `GOOGLE_CLIENT_SECRET` at all. On a real deployment `connect` would answer `not_configured`.
  I did not touch it — `ekoa-deploy` is reference-only per the governance rules, and the fix
  is a decision about which name wins.
- **`achieve` and `plan` are unexercised.** Both need the model credential, and provisioning
  it was blocked for me. The deterministic `execute` path does not need it.
- **The 1309-line session view is bigger than "minimal".** It works and is tested, but it is
  more surface than a test rig strictly needs.
- **Another session is editing `ekoa-code` concurrently.** There are unrelated uncommitted
  changes in `web/` (device-activation i18n, artifacts surface) and `drills/` that are not
  mine. My commits name only my own files; do not assume a clean tree.
- The stack's ephemeral-by-default database means that if you start it *without*
  `EKOA_DEV_DB_PATH`, you will redo the Google consent on every restart.
