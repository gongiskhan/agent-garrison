# A rotating credential is LINKED into a runtime home, never copied

**Date:** 2026-08-16
**Status:** Shipped

## Context

Garrison isolates each instance's Codex config: the launcher exports
`CODEX_HOME=$GARRISON_HOME/runtime-homes/codex`, so `config.toml`, sessions,
history and MCP servers stay per-instance. To make that home usable, three
places seeded it with the box's login by **copying** `~/.codex/auth.json`:

- `fittings/seed/codex-runtime`'s setup hook (`87efd924`, 2026-07-22) —
  copy-if-missing into the instance runtime home;
- `importNativeLogin` (`3b8511bd`, 2026-07-25) — "adopt the box's own login as a
  named account", sealing a copy into the vault and materializing it into a
  per-account home;
- `scripts/matrix-harness.mjs` and `tests/codex-primary-smoke.integration.test.ts`
  — a copy into a `mkdtemp` home.

Each copy read as harmless: "copy, never move — the box's own login is left
exactly as it was."

It was not harmless. A ChatGPT `auth.json` holds a **rotating** refresh token:
refreshing mints a new one and invalidates the old, and presenting a superseded
one reads as replay, which revokes the whole token family. Two homes holding
copies of one login are therefore not two working logins — they are a race whose
loser is logged out, and whose provider-side punishment logs out the winner too.
The temp-home variants are worse still: the only live token ends up inside a
directory the harness deletes.

The host paid for this five times. `~/.codex/log/codex-login.log` records fresh
browser logins on 2026-07-11, 2026-08-03 (×3), 2026-08-13 and 2026-08-16, and
Garrison's own Codex sessions carry the other half of the evidence — "Your
access token could not be refreshed because your refresh token was revoked" on
2026-08-09 and twice on 2026-08-13, the last of them 41 minutes after a copy was
seeded from a login that had just succeeded.

## Decision

**One machine, one login, one credential file.** A Garrison-managed runtime home
never holds a copy of a credential another live home also holds.

- `fittings/seed/codex-runtime/scripts/provision-home.mjs` symlinks the box's
  `auth.json` into the isolated `CODEX_HOME`, and repairs a home that already
  holds a duplicate copy. Verified against codex-cli 0.147.0: the CLI rewrites
  `auth.json` **through** the symlink (write-in-place, not tmp+rename), so the
  link survives both a login and a refresh. A file belonging to a *different*
  identity is never clobbered — it is left alone with a warning.
- `config.toml` is still copied. It is settings, not a credential; per-instance
  divergence is the point of the isolated home.
- `importNativeLogin` refuses a rotating credential (`isRotatingCredential`) and
  names the two honest alternatives: **Machine login** to run as this box's
  login (no account needed — it is the default), or **Device login** to mint a
  named account its own credential. A static credential (a bare API key in the
  native file) is still importable, because copying one is inert.
- The two harnesses link instead of copying.

## Consequences

Isolation of everything that should be isolated is unchanged; only the
credential is shared, because a credential is the one thing that cannot be.
Re-logging in on the box propagates to every instance immediately, and no
Garrison run can log the box out.

The narrow remaining race — the box's CLI and a Garrison run refreshing the same
file in the same instant — is bounded by the file being singular, and is not the
guaranteed mutual revocation the copies produced.

**Source:** `fittings/seed/codex-runtime/scripts/provision-home.mjs`,
`src/lib/account-env.ts` (`isRotatingCredential`), `src/lib/account-login.ts`
(`importNativeLogin`), `tests/codex-credential-link.test.ts`.
