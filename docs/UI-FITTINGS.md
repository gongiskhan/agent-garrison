# UI Fittings

Canonical pattern for Garrison Fittings that bring their own user interface. Locked in 2026-05-16; see [DECISIONS.md](./DECISIONS.md) §"UI-Fitting port convention" for the decision record.

## The rule

> **Each UI-bearing Fitting serves its own UI on its own established port. Consumers reference it by URL, not by importing components or sharing state.**

That is the whole contract.

## Why

Coupling between UI Fittings would re-introduce the problem composability solves. If the chat surface imports the Monitor's React components, the Monitor can't ship a Vue rewrite. If they share state, a Monitor restart breaks chat. Linking by URL is the lowest-bandwidth integration that still lets one Fitting talk about another:

- One Fitting renders → publishes a status file → the next Fitting reads the file → links to the URL.
- If the providing Fitting isn't installed or isn't running, the link silently disappears. No errors, no missing components, no broken builds.
- A consumer-side change does not force a provider rebuild and vice versa.

## How it works

Each UI Fitting has three pieces:

1. **Manifest declaration.** In the Fitting's `apm.yml`'s `x-garrison` block, add a `config_schema` entry called `port` with a default (the Fitting's well-known port). For the Monitor, that's `7077`.
2. **Server.** At startup, the Fitting tries to bind the declared port. If the port is taken, it falls back via the next-free-port helper. The actual chosen port is written to a status file:

   ```
   ~/.garrison/ui-fittings/<fitting-id>.json
   ```

   Status-file shape:

   ```json
   {
     "fittingId": "monitor",
     "port": 7077,
     "url": "http://127.0.0.1:7077",
     "pid": 12345,
     "startedAt": "2026-05-16T10:30:00.000Z"
   }
   ```

   The file is removed cleanly on `SIGTERM` / `SIGINT`.
3. **Health endpoint.** The Fitting serves `GET /health` returning `{ "ok": true, ... }`. Consumers ping it to verify the URL is reachable before linking. A 1.5-second timeout is enough.

## Consumer pattern

A Fitting (or the Garrison Next.js app) that wants to surface a link to another UI Fitting:

1. Read `~/.garrison/ui-fittings/<fitting-id>.json`. Missing file → unavailable. Stop.
2. `GET <url>/health` with a 1.5-second timeout. Non-200 or timeout → unavailable. Stop.
3. Otherwise render a link that opens `<url>` in a new tab (or a full-screen overlay on small viewports — implementation choice).
4. Re-check on a slow cadence (every 15s is fine) so the link appears/disappears with the Fitting.

The Garrison Next.js layer ships one such consumer today: `src/app/api/monitor/discover/route.ts` is the discovery endpoint, and `src/components/chat/ChatPanel.tsx` renders the conditional "Monitor ↗" link in the chat header.

## Build pipeline (for the React UIs)

React + esbuild, with the build run from the Fitting directory and resolving `react` / `react-dom` from the Garrison root `node_modules`:

```
fittings/seed/<fitting-id>/
├── apm.yml
├── scripts/
│   ├── start.mjs    # entrypoint: parse args/env, hand off to server
│   ├── server.mjs   # HTTP + SSE + static dist/
│   └── probe.mjs    # --probe → "ok"; exits 0 on success
├── ui/
│   ├── index.html
│   ├── main.tsx
│   ├── styles.css
│   └── build.mjs    # esbuild script writing into ../dist/
└── dist/            # build output; static-served by server.mjs
    ├── index.html
    ├── <name>.bundle.js
    └── <name>.css
```

Run-time discovery:
- `start.mjs` reads CLI flags (`--port`, `--host`, `--parent-pid`, `--poll-ms`) and env vars.
- `server.mjs` binds, writes the status file, serves `dist/` and any API/SSE endpoints, cleans up on exit.
- `probe.mjs` is the verify-hook surface: it imports `server.mjs` (which auto-runs only when invoked directly) and binds an ephemeral port to confirm the server module loads and a port can be bound.

The build script is co-located with `ui/`:

```bash
node fittings/seed/<id>/ui/build.mjs
```

It writes `dist/index.html`, `dist/<name>.bundle.js`, `dist/<name>.css`. No `node_modules` is materialised inside the Fitting — `react` / `react-dom` / `esbuild` come from the Garrison repo root.

## Reference implementations

- **`monitor-default`** (this milestone). Port 7077. Serves a React card-grid + drill-down + SSE log tail.
- The pattern generalises to documents-viewer, future workbench surfaces, anything UI-bearing.

## Anti-patterns

- **Importing another Fitting's React components.** Don't. The whole point of the URL-link pattern is that UI Fittings can be written in different frameworks, restarted independently, and uninstalled cleanly.
- **Storing the port in the consumer's source.** Don't hardcode `7077` in chat; read the status file every time.
- **Sharing state across Fittings.** The Monitor does not push events into the chat panel and vice versa. If you find yourself needing a shared store, that's a sign one Fitting wants to consume a non-UI capability the other provides — declare it as a `provides`/`consumes` pair in `x-garrison`, not as a UI cross-call.
- **Long-lived status files.** Clean up on `SIGTERM` and `SIGINT`. A stale file pointing at a dead URL is worse than no file.

## See also

- [CAPABILITIES.md](./CAPABILITIES.md) — provides/consumes vocabulary; the `monitor` capability kind.
- [FACULTIES.md](./FACULTIES.md) — the `monitor` Faculty entry.
- [DECISIONS.md](./DECISIONS.md) — 2026-05-16 decisions on UI Fittings, shared spawn helper, and the port convention.
- [FITTINGS.md](./FITTINGS.md) — Fitting authoring guide.
