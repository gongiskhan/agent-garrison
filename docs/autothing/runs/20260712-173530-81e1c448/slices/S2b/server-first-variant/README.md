# server-first-variant (PRESERVED, NOT ACTIVE)

Reference copy of the **server-first** opencode-runtime design that was explored
during S2b and deliberately NOT shipped. The shipped fitting is the stateless
run-subprocess design under `fittings/seed/opencode-runtime/` (see `../impl.md`).

These files are inert reference artifacts: they are not imported, compiled,
typechecked, linted, or tested by the project (tsconfig includes only `.ts`/`.tsx`;
vitest runs only `tests/*.test.ts`). They are kept so the design is not lost and can
seed a future upgrade.

Contents:
- `apm.yml` — the server-first manifest (standing `opencode serve`, extra config_schema
  keys: `base_url`, `server_port`, `server_password`).
- `lib/opencode-adapter.mjs` — `OpenCodeAdapter` that boots/attaches `opencode serve`,
  opens a session over the HTTP API, posts prompts (legacy send-and-await primary, v2
  `POST /api/session/{id}/prompt` + `/wait` fallback), and tears down only a server it
  spawned; degrades to a stateless `opencode run` subprocess when the server can't boot.
- `scripts/bridge.mjs` — the matching bridge that materializes a SCOPED opencode config
  (never touching the user's `~/.config/opencode`) pointing at a local provider, and
  boots the server per delegate.

See `../impl.md` → "Future upgrade path: server-first variant" for why and when to
revive it.
