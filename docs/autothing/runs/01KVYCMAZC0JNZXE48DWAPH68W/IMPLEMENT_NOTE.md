# Implement note — Kanban Loop V1d

## What changed

- **S1 — env-drift heal for own-port fittings** (`src/lib/own-port-lifecycle.ts` + `src/lib/runner.ts`): the spawn record now carries an `envFingerprint` (sha256 over the tracked keys `GARRISON_GATEWAY_URL`, `GARRISON_COMPOSITION_ID`). When `up` finds a fitting already running but the desired-env hash has drifted, it heals (kill + respawn) the same way it already heals a keyless vault-consuming fitting. `StartResult` now reports `healReason: "vault" | "env-drift"` so the runner log says which.
- **S2 — visible dispatch failure** (`fittings/seed/kanban-loop/lib/engine.mjs`, `fittings/seed/kanban-loop/scripts/server.mjs`, `fittings/seed/kanban-loop/ui/{api.ts,main.tsx,styles.css}`): added a persistent `card.lastDispatchError = { at, reason, listId, message }` set by the engine on transport-defer / run-failed AND by `handlePatchCard` when an auto-dispatch can't reach the gateway. The UI surfaces it as a red chip + an inline reason + a Retry button on agent lists. A successful run clears it back to null.
- **S3 — runtime channel discovery** (`fittings/seed/kanban-loop/scripts/server.mjs` + `fittings/seed/kanban-loop/ui/{api.ts,main.tsx}`): new `GET /board/runtime` returns `{ webChannelEmbedId, webChannelUrl, gatewayBaseUrl, noGateway }`. The web channel id is discovered by scanning `~/.garrison/ui-fittings/*.json` for `web-channel*` (preferring `web-channel-default.json`). The UI fetches it on mount; the Discuss WatchSheet uses the discovered embed id (no more hardcoded `/embed/web-channel-default`) and shows a clear "no web channel installed" panel when nothing is up. A `noGateway` banner appears in the topbar.
- **S4 — live vision spec** (`tests/live-vision/kanban-loop-v1d.{spec,config}.ts`): a Playwright spec that drives the user's REAL composition (no sandbox), screenshots each FINDING state under `<runDir>/vision/<NN>-<slug>.png`, and writes a draft `FINDINGS.md` for the walkthrough list to mark OK after vision review. Long-running (Plan-turn budget defaults to 25 min, configurable via `KANBAN_V1D_TURN_BUDGET_MS`). Run with `KANBAN_V1D_RUN_DIR=docs/autothing/runs/01KVYCMAZC0JNZXE48DWAPH68W npx playwright test --config tests/live-vision/kanban-loop-v1d.config.ts`.

## Honest scope note

The brief's Acceptance §10 — "A full vision walkthrough (screenshots) of the above exists; no broken path remains" — is the walkthrough list's job. This implement step wrote the code + the spec that produces the evidence; it did NOT run the spec against the user's live gateway (would require restarting/burning a 25-min Plan turn on the user's running operative). The walkthrough list runs the spec, reads each PNG, and only then prints the `KANBAN-LOOP-V1D OK` sentinel.

## Self-checks

- `npx tsc --noEmit` — clean.
- `npx vitest run` on the kanban + own-port suites — 128/128 pass.
- `node fittings/seed/kanban-loop/ui/build.mjs` — fresh dist produced.

## Files touched

- `src/lib/own-port-lifecycle.ts`
- `src/lib/runner.ts`
- `fittings/seed/kanban-loop/lib/engine.mjs`
- `fittings/seed/kanban-loop/scripts/server.mjs`
- `fittings/seed/kanban-loop/ui/api.ts`
- `fittings/seed/kanban-loop/ui/main.tsx`
- `fittings/seed/kanban-loop/ui/styles.css`
- `fittings/seed/kanban-loop/dist/` (rebuilt)
- `tests/live-vision/kanban-loop-v1d.config.ts` (new)
- `tests/live-vision/kanban-loop-v1d.spec.ts` (new)
