# Implement note — Kanban Loop V1d (continuation run S5/S6/S7)

## What changed

- **S5 — spec fixup**: exported `readWebChannelStatus(statusDir = STATUS_ROOT)` from `fittings/seed/kanban-loop/scripts/server.mjs` so tests can drive channel discovery without spinning up the live server. No behavior change for production callers (default arg preserves the existing path).
- **S6 — coverage for the V1d code changes**:
  - `tests/own-port-env-drift-heal.test.ts` (NEW, 8 tests) — pins the `envFingerprintForExtraEnv` contract: stable 64-char digest, deterministic, untracked keys ignored, missing vs empty-string distinguished, undefined extraEnv stable, key-order-insensitive, no-loop property.
  - `tests/kanban-runtime-endpoint.test.ts` (NEW, 6 tests) — sandboxed-tmpdir tests for `/board/runtime`'s channel discovery: zero channels, one channel, multiple channels (prefers `web-channel-default.json`), malformed JSON skipped, mismatched fittingId rejected, missing directory tolerated.
- **S7 — walkthrough harness**: `scripts/kanban-v1d-walkthrough.mjs` (NEW). Preflights the live composition, runs the V1d Playwright spec with `KANBAN_V1D_RUN_DIR` set, counts OK/TODO in the generated `FINDINGS.md`, and exits non-zero unless every finding is OK. `--dry-run` prints the recipe and exits 0 without touching the live composition. Added `npm run kanban:v1d:walkthrough` script entry in `package.json`.

## Acceptance (from the plan)

1. `npx tsc --noEmit` — clean.
2. `npx vitest run tests/own-port-env-drift-heal.test.ts tests/kanban-runtime-endpoint.test.ts` — 14/14 pass.
3. `node scripts/kanban-v1d-walkthrough.mjs <runId> --dry-run` — exits 0 and prints the recipe.
4. (Walkthrough list's responsibility) The harness, when actually run against the user's live composition with all 10 findings marked OK by the operative, prints the literal `KANBAN-LOOP-V1D OK`.

All 1–3 confirmed locally. The full 10-suite kanban+own-port run is 142/142 green.

## Files touched

- `fittings/seed/kanban-loop/scripts/server.mjs` (one export keyword)
- `tests/own-port-env-drift-heal.test.ts` (new)
- `tests/kanban-runtime-endpoint.test.ts` (new)
- `scripts/kanban-v1d-walkthrough.mjs` (new)
- `package.json` (one script entry)
