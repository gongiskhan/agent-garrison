# FLOW_PLAN — Kanban Loop V1d (continuation run)

**Run:** `docs/autothing/runs/01KVYA1HV6V624CNX87ASSP86S`
**Brief:** `BRIEF/kanban-loop-v1d-make-everything-work.md`
**Prior implement:** `docs/autothing/runs/01KVYCMAZC0JNZXE48DWAPH68W/IMPLEMENT_NOTE.md` (S1/S2/S3 + the S4 spec already shipped, type-check clean, 128/128 unit tests pass, kanban-loop dist rebuilt)

## State at start of this run

The code-level fixes from the original V1d brief landed in the prior run. Already shipped:

- **S1 — env-drift heal** for own-port fittings: `SpawnRecord.envFingerprint` (sha256 over `GARRISON_GATEWAY_URL`, `GARRISON_COMPOSITION_ID`); a heal on hash mismatch with `healReason: "env-drift"` distinct from the prior `"vault"` reason. `src/lib/own-port-lifecycle.ts` + `src/lib/runner.ts`.
- **S2 — visible dispatch failure**: persisted `card.lastDispatchError = { at, reason, listId, message }`, set on transport defer / run failure (engine) and on `handlePatchCard` gateway-unreachable auto-dispatch (server). UI surfaces a red chip + inline reason + Retry button on agent lists; cleared on next successful dispatch. `fittings/seed/kanban-loop/lib/engine.mjs`, `scripts/server.mjs`, `ui/{api.ts,main.tsx,styles.css}`.
- **S3 — runtime channel discovery**: `GET /board/runtime` returns `{ webChannelEmbedId, webChannelUrl, gatewayBaseUrl, noGateway }`. The Discuss WatchSheet uses the discovered embed id (no more hardcoded `web-channel-default`); a "no web channel installed" panel renders when none is up; a `noGateway` topbar banner explains why agent lists won't dispatch.
- **S4 spec written, not run**: `tests/live-vision/kanban-loop-v1d.{spec,config}.ts` — a Playwright spec that drives the user's REAL composition (no sandbox), screenshots each FINDING under `<runDir>/vision/<NN>-<slug>.png`, and writes a draft `FINDINGS.md` for the walkthrough list to mark `OK`.

## What this re-plan covers

The brief's §Acceptance is satisfied only when a vision walkthrough exists and the operative has READ every screenshot. That is the walkthrough list's responsibility, not implement's, and the prior run honestly stopped short of running the live spec against the user's running Plan-turn-budget (would require restarting/burning a 25-min turn on the user's gateway).

This continuation run plans the bridge work the walkthrough list needs to land the V1d gate cleanly, without re-implementing what's already shipped.

## Out of scope (per brief)

- Web channel staying generic, operative test interface, web channel's own design.

## Slices

| # | Slice | Scope | Critical files |
|---|---|---|---|
| S5 | Wire the live vision spec into the autothing-walkthrough skill so it discovers `tests/live-vision/kanban-loop-v1d.{config,spec}.ts`, passes the right `KANBAN_V1D_RUN_DIR`, and surfaces failures clearly. The spec itself stays as-shipped; this slice only adds the invocation glue + a per-run output dir. | `tests/live-vision/kanban-loop-v1d.spec.ts` (small fixups discovered while wiring), `tests/live-vision/kanban-loop-v1d.config.ts`, `docs/autothing/runs/<runId>/vision/`, `docs/autothing/runs/<runId>/FINDINGS.md` |
| S6 | Targeted unit/integration test for the V1d code changes that survived without coverage: env-drift heal triggers on fingerprint mismatch, doesn't trigger when fingerprints match, doesn't loop; `/board/runtime` shape under the three real states (channel present / channel absent / multiple channels). Add to existing vitest suites — no new harness. | `tests/own-port-env-drift-heal.test.ts` (new), `tests/kanban-runtime-endpoint.test.ts` (new) |
| S7 | Walkthrough harness: write a thin `scripts/autothing/kanban-v1d-walkthrough.mjs` (or document a `npm run` recipe) that an operative can invoke with the run id to run the live spec against the real composition, then summarises the FINDINGS markers + prints the `KANBAN-LOOP-V1D OK` sentinel ONLY when every finding is `OK`. Operative must read each PNG before flipping any TODO to OK; the script does NOT auto-pass. | `scripts/kanban-v1d-walkthrough.mjs` (new), `package.json` (one `kanban:v1d:walkthrough` script entry) |

## Detailed slice notes (just enough)

### S5 — wire the spec

The spec already gates on `KANBAN_V1D_RUN_DIR`; this slice ensures the autothing-walkthrough skill (or the equivalent kanban-walkthrough list) sets it to THIS card's run dir and that the `vision/` output dir exists before the spec writes its first PNG. Surface a clear failure when the live composition isn't up (the spec already errors loudly in `beforeAll`).

### S6 — coverage for the V1d code

Two small vitest files:

1. `tests/own-port-env-drift-heal.test.ts` — uses the same in-memory faux-spawn pattern as `tests/own-port-lifecycle.test.ts`. Cases:
   - same fingerprint twice → `alreadyRunning`, no heal.
   - different fingerprint with the same recorded pid alive → heal, `healReason === "env-drift"`.
   - record missing `envFingerprint` (legacy) → no spurious heal.
   - heal does not loop (second start with the same env writes a fresh fingerprint).
2. `tests/kanban-runtime-endpoint.test.ts` — drives `makeRequestHandler` (already exported) with a synthetic `STATUS_ROOT` containing 0 / 1 / 2 channel status files, asserts the `/board/runtime` JSON shape and `noGateway` boolean.

### S7 — walkthrough harness

Two-step script (live, no auto-OK):

```
node scripts/kanban-v1d-walkthrough.mjs <runId>
  1. confirms 127.0.0.1:7777/health + GARRISON_GATEWAY_URL/health
  2. runs `npx playwright test --config tests/live-vision/kanban-loop-v1d.config.ts`
     with KANBAN_V1D_RUN_DIR=docs/autothing/runs/<runId>
  3. prints the FINDINGS.md path + a one-line summary of TODO vs OK counts
  4. exits non-zero unless every finding is OK (the operative flips TODO→OK
     manually after reading the PNGs; the script never does it for them)
```

## Critical files for implementation

- `tests/live-vision/kanban-loop-v1d.spec.ts` — minor fixups only.
- `tests/own-port-env-drift-heal.test.ts` (NEW).
- `tests/kanban-runtime-endpoint.test.ts` (NEW).
- `scripts/kanban-v1d-walkthrough.mjs` (NEW).
- `package.json` — one script entry.
- `docs/autothing/runs/01KVYA1HV6V624CNX87ASSP86S/{vision,FINDINGS.md}` — produced at walkthrough time, not implement time.

## Decisions made autonomously

- **No churn in S1/S2/S3 code.** Already shipped + tested; the brief's Acceptance §1–9 is satisfied at the code level. Re-touching now invites regressions.
- **Walkthrough script never auto-passes a FINDING.** The brief is explicit ("READ the screenshot (vision)"); a script that grep-marks OK based on test exit code defeats the whole point of V1d.
- **No new playwright project / no CI integration.** The live spec stays opt-in via its own config, exactly because it requires the user's running composition.

## Acceptance (machine-checkable)

This continuation run is complete when:

1. `npx tsc --noEmit` clean.
2. `npx vitest run tests/own-port-env-drift-heal.test.ts tests/kanban-runtime-endpoint.test.ts` passes (both new files green).
3. `scripts/kanban-v1d-walkthrough.mjs --dry-run` exits 0 and prints the recipe + the next-step pointer (does NOT require the live gateway).
4. The walkthrough list, when actually run by the operative against the user's live composition, can produce `docs/autothing/runs/01KVYA1HV6V624CNX87ASSP86S/FINDINGS.md` with the 10 brief findings all `OK` and the literal final stdout line:

```
KANBAN-LOOP-V1D OK
```

(That final assertion is the walkthrough list's, not implement's.)

## Risks / open notes

- A real Plan turn through the live operative can take ≥ 15 minutes; the spec's per-test timeout already budgets 30 min.
- Restarting the gateway during the live spec affects other in-flight sessions on the host — keep it out of S5/S6/S7 and let the operative restart it manually if needed during the walkthrough.
