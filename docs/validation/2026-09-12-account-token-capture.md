# Account token capture recovery — 12 September 2026

Owner: dev-madrid. Report: guided Claude login displayed Token rejected after
`claude setup-token` reported successful token creation.

## Cause and change

The helper removed ANSI sequences instead of interpreting terminal cursor
movements. The following instruction's word `Store` became part of the captured
credential: the reported local value was 113 characters and ended in that word.
Removing exactly those five characters produced a token Anthropic verified.
The helper could also capture an incomplete token at a PTY chunk boundary.

`scripts/lib/account-login-output.mjs` now reads a headless terminal, preserves
cursor-rendered word and line boundaries, joins soft wraps and waits for the
completion instructions or successful CLI exit before capture. Status output
redacts partial and wrapped tokens. The helper drains queued terminal writes
before processing CLI exit.

Separately, `addAccount` previously wrote only the local vault. The shared
credential was still an older 108-character token that Anthropic reported as
revoked. Enrolled account saves now write the one account key to the shared
authority before replacing the local copy. Failed authority writes preserve the
local credential and registry; standalone saves remain local.

## Verification and live recovery

- 49 tests passed across account-login-output, account-login-authority,
  account-verify and accounts. Coverage includes an actual helper subprocess
  using node-pty with a synthetic CLI, cursor motion, split output, soft wraps,
  redaction, successful exit and authority failure ordering.
- `npm run typecheck` and `git diff --check` passed.
- A bounded Anthropic probe accepted the recovered credential. The existing
  account API restored it in the running app, and the authenticated state API
  replaced the old shared value. Readback confirmed matching credentials,
  account status `ready`, `needs_relogin: false`, and last verdict `verified`.
- The original completed dialog retains its historical result; close it and
  refresh the account view to see the recovered state.

## Deployment boundary

The login helper is launched from source for each attempt, so the capture fix
is active on dev-madrid without restarting any service. The shared-save backend
change requires a subsequent app deployment. The existing Two Homes activation
hold remains in force; this fix performs no runtime migration or service restart.
This account's shared credential is already repaired through the current API.
