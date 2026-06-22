---
name: run-garrison
description: Run, launch, restart, and screenshot Agent Garrison — the local Next.js web app on 127.0.0.1:7777. Use when asked to start Garrison, confirm a change works in the real app, take a screenshot of a route, or smoke-test the UI. Covers the launchd supervisor, the corrupt-.next 500, and the Playwright driver.
---

Agent Garrison is a **Next.js 14 web app served on `127.0.0.1:7777`** (plus an
"outpost" host, `node scripts/outpost-host.mjs`). On this machine it is **kept
running by a launchd job** — you usually don't start it, you confirm it's up and
restart it when wedged. Drive it via the committed Playwright script
`.claude/skills/run-garrison/driver.mjs`, which smoke-tests the core routes and
writes a screenshot per route. There is no `chromium-cli` here; `playwright`
(a dev dep, with cached Chromium) is the browser handle.

All paths below are relative to the repo root (`/Users/ggomes/dev/garrison`).

## Prerequisites

- macOS, Node 20 (`node -v` → v20.x — this repo verified on v20.19.4).
- Deps installed: `npm install` (the `postinstall` fixes node-pty perms). This
  also makes `playwright` + its cached Chromium available — no separate
  `npx playwright install` was needed here.

## Run (agent path) — the driver

This is the path to use. It does a fast HTTP status sweep (catches 500s without
paying for a browser), then screenshots each route.

```bash
node .claude/skills/run-garrison/driver.mjs
```

Expected output ends with `OK: all routes served and screenshotted.` and exits 0.
Screenshots land in `/tmp/garrison-<route>.png` (`home`, `compose`, `armory`,
`quarters`, `vault`, `run`). **Open at least one** — a 200 with a blank/error
frame is still a failure.

Drive specific routes, or change output dir / target:

```bash
node .claude/skills/run-garrison/driver.mjs /quarters /vault
SHOT_DIR=/tmp/shots GARRISON_URL=http://127.0.0.1:7777 node .claude/skills/run-garrison/driver.mjs
```

A bare HTTP smoke without a browser (when you only need status codes):

```bash
for r in / /compose /armory /quarters /vault /run; do \
  printf "%-12s " "$r"; curl -s -o /dev/null -w "%{http_code}\n" --max-time 60 "http://127.0.0.1:7777$r"; done
```

## Is it already up? (it usually is)

A launchd job runs the dev server, so the port is normally already serving:

```bash
lsof -iTCP:7777 -sTCP:LISTEN          # node next-server listening = up
launchctl list | grep -i garrison      # -> io.garrison.dev, io.garrison.outpost
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7777/   # 200 = healthy
```

## Restart cleanly (and fix the corrupt-.next 500)

The most common failure is a **stale/corrupt Next build cache**: some routes
return **500** with `Cannot find module './<n>.js'` (from
`.next/server/webpack-runtime.js`) while others still serve 200. `next dev`
recompiles on the fly but does **not** always self-heal this — you must remove
`.next`.

Because launchd supervises it, **killing the PID is useless** — it respawns
instantly against the same corrupt cache. Clear the cache, then kickstart the
job:

```bash
rm -rf .next
launchctl kickstart -k "gui/$(id -u)/io.garrison.dev"
# first request triggers a fresh compile (can take ~10-60s):
curl -s -o /dev/null -w "home=%{http_code}\n" --max-time 90 http://127.0.0.1:7777/
```

Then re-run the driver to confirm all routes are 200 again.

## Run (human / fresh-checkout path)

On a machine **without** the launchd job, start it directly:

```bash
npm start      # concurrently: `next dev -H 127.0.0.1 -p 7777` + the outpost host
```

On this machine `npm start` will hit `EADDRINUSE` because launchd already holds
7777 — use the kickstart recipe above instead. `npm run start:mobile` binds
`0.0.0.0` for LAN/phone access.

## Test

The driver is a runtime smoke, not the test suite. Verified clean this session:

```bash
npm run typecheck      # tsc --noEmit  -> 0 errors, ~2s
```

The other committed gates (not run here — see CLAUDE.md): `npm test` (vitest) and
`npm run test:e2e` (playwright). Note: a few full-suite vitest failures are known
to be pre-existing and disjoint from app-launch (gemini-runtime, agent-sdk-runtime
FENCE, orchestrator-integration which needs a live gateway) — don't treat those as
a broken app.

## Gotchas

- **`networkidle` hangs.** Garrison holds long-lived SSE/polling connections
  (the Run-tab live log), so the network never goes idle. The driver uses
  `waitUntil: 'domcontentloaded'` + a 1.5s settle. Do not switch it to
  `networkidle`.
- **A Playwright script must live inside the repo tree.** ESM resolves
  `import 'playwright'` from the script's own location upward — a copy in `/tmp`
  fails with `ERR_MODULE_NOT_FOUND`. `driver.mjs` lives under
  `.claude/skills/run-garrison/` so it resolves the project `node_modules`.
- **Don't click Run / Verify to "smoke" it.** Those buttons trigger a real
  `apm install` and spawn a live Operative (Claude Code via the Agent SDK on the
  user's Max account). Navigation + screenshot is the non-destructive check.
- **Two launchd jobs, not one.** `io.garrison.dev` is the Next dev server;
  `io.garrison.outpost` is separate. Kickstart `io.garrison.dev` for app issues.
- **Other repos share the box.** Harmonika (port 3500) and Ekoa (5983) run their
  own next-server processes. When grepping `ps` for the dev server, scope to
  `garrison/` so you don't touch them.

## Troubleshooting

- **500 on `/`, `/compose`, `/vault`, `/run` but 200 on `/armory`, `/quarters`** →
  corrupt `.next`. Run the *Restart cleanly* recipe.
- **`fetch`/curl connection refused** → server isn't up. Check
  `launchctl list | grep garrison`; if the job is loaded but no listener,
  `launchctl kickstart -k "gui/$(id -u)/io.garrison.dev"`.
- **Driver: `ERR_MODULE_NOT_FOUND: 'playwright'`** → you copied the script out
  of the repo. Run it from its committed path under `.claude/skills/run-garrison/`.
- **Driver: every route shows `ERR ... Timeout`** → likely first-compile latency;
  re-run, or warm the route once with `curl` first.
