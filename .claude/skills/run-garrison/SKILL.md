---
name: run-garrison
description: Run, launch, restart, and screenshot the isolated Codex Agent Garrison instance — the local Next.js web app on 127.0.0.1:27777. Use when asked to start Garrison, confirm a change works in the real app, take a screenshot of a route, or smoke-test the UI. Covers the checkout-local launcher, the corrupt-.next 500, and the Playwright driver.
---

Agent Garrison is a **Next.js 14 web app served on `127.0.0.1:27777`** (plus an
"outpost" host and scheduler). This checkout is the **secondary Codex instance**:
the package scripts launch it with isolated Garrison and Claude homes through
`scripts/start-codex-instance.sh`. Drive it via the committed Playwright script
`.claude/skills/run-garrison/driver.mjs`, which smoke-tests the core routes and
writes a screenshot per route. There is no `chromium-cli` here; `playwright`
(a dev dep, with cached Chromium) is the browser handle.

All paths below are relative to this repository root.

## Prerequisites

- Node 20 (`node -v` → v20.x — this repo verified on v20.19.4).
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
SHOT_DIR=/tmp/shots GARRISON_URL=http://127.0.0.1:27777 node .claude/skills/run-garrison/driver.mjs
```

A bare HTTP smoke without a browser (when you only need status codes):

```bash
for r in / /compose /armory /quarters /vault /run; do \
  printf "%-12s " "$r"; curl -s -o /dev/null -w "%{http_code}\n" --max-time 60 "http://127.0.0.1:27777$r"; done
```

## Is it already up?

```bash
lsof -iTCP:27777 -sTCP:LISTEN
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:27777/
# Inspect the exact isolated homes and ports without starting anything:
bash scripts/start-codex-instance.sh env
```

## Restart cleanly (and fix the corrupt-.next 500)

The most common failure is a **stale/corrupt Next build cache**: some routes
return **500** with `Cannot find module './<n>.js'` (from
`.next/server/webpack-runtime.js`) while others still serve 200. `next dev`
recompiles on the fly but does **not** always self-heal this — you must remove
`.next`.

Stop the existing `npm start` process through the terminal/session that launched
it. Once all three child processes have exited, clear the cache and start the
isolated stack again:

```bash
rm -rf .next
npm start
# first request triggers a fresh compile (can take ~10-60s):
curl -s -o /dev/null -w "home=%{http_code}\n" --max-time 90 http://127.0.0.1:27777/
```

Then re-run the driver to confirm all routes are 200 again.

## Run the stack

```bash
npm start      # Next :27777 + isolated outpost host + isolated scheduler
```

`npm run start:mobile` binds the Next app to `0.0.0.0` for LAN/phone access.
If `npm start` reports `EADDRINUSE`, find the existing listener and stop it
through its owning terminal/session; do not use a broad process-name kill.

## Test

The driver is a runtime smoke, not the test suite. Verified clean this session:

```bash
npm run typecheck      # tsc --noEmit  -> 0 errors, ~2s
```

The other committed gates (see CLAUDE.md) are `npm test` (vitest) and
`npm run test:e2e` (playwright).

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
- **Other repos share the box.** Harmonika (port 3500) and Ekoa (5983) run their
  own next-server processes. When grepping `ps` for the dev server, scope to
  this checkout path so you don't touch them.

## Troubleshooting

- **500 on `/`, `/compose`, `/vault`, `/run` but 200 on `/armory`, `/quarters`** →
  corrupt `.next`. Run the *Restart cleanly* recipe.
- **`fetch`/curl connection refused** → server isn't up. Run `npm start` in this
  checkout and keep the owning terminal/session alive.
- **Driver: `ERR_MODULE_NOT_FOUND: 'playwright'`** → you copied the script out
  of the repo. Run it from its committed path under `.claude/skills/run-garrison/`.
- **Driver: every route shows `ERR ... Timeout`** → likely first-compile latency;
  re-run, or warm the route once with `curl` first.
