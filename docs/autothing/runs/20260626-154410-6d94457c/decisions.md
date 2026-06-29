# autothing run 20260626-154410-6d94457c — decisions & findings

## Pre-existing test baseline on `main` (BEFORE this run)
Measured by stashing all S1 edits and running `npm test`: **12 failing tests on `main`**, none introduced by this run. Categorized by blast radius:
- **In this feature's blast radius (will be fixed by the relevant slice):**
  - `tests/seed.test.ts` (3) — referenced removed `memory` seed; **FIXED in S1** (→ `basic-memory`).
  - `tests/validation.test.ts` "seed memory passes all four checks" — same `memory`→`basic-memory` drift. Fix in C-group (seed inventory).
  - `tests/claude-install.test.ts` "resolves the memory fitting's skill" — same drift. Fix in C-group.
  - `tests/scheduler-cli.test.ts` (2) — scheduler. Fix in **B1** (scheduler daemon).
  - `tests/web-channel-context.test.ts` (3) — doc-render / `garrison://` links / artifact-store. Fix in **D2** (drop artifact-store).
  - `tests/fitting-files-api.test.ts` (1) — file API; relevant to D1 File Browser.
- **Genuinely unrelated (parked WIP by the repo owner — NOT this run's responsibility):**
  - `tests/gemini-runtime.test.ts` (1) — parked "model-router orchestrator + improver + workflows (codex/gemini draft)" workstream (seen in `git stash list`).
  - `tests/orchestrator-placement.test.ts` (1) — same parked workstream.
  Decision: leave these two; they predate the run and belong to a parked draft. Enumerated as known pre-existing in the global gate, with this stash-baseline as evidence. The run introduces ZERO new failures and fixes every failure in its own blast radius.

## Baseline burn-down (updated after G0)
Pre-existing failures fixed so far (all in this feature's blast radius): seed.test×3, validation.test (memory→basic-memory), claude-install.test (→basic-memory), scheduler-cli×2 (register/enable implemented in B1) + improver-nightly (its register/enable now works). **Baseline 12 → 5 remaining:**
- `fitting-files-api.test.ts` (1) — fix in **D1** (File Browser reuses the files API).
- `web-channel-context.test.ts` (3) — fix in **D2** (drop artifact-store; garrison:// link render).
- `gemini-runtime.test.ts` (1) + `orchestrator-placement.test.ts` (1) — **genuinely parked WIP, NOT this feature's blast radius** (the parked model-router/codex/gemini workstream); left as documented pre-existing, evidence = the stash baseline.

## S1 — capability vocabulary (DONE)
- `connector` capability kind + `connectors` faculty (Agent-tier, multi, order 17, appended — "append don't renumber" precedent) + `x-garrison.connector` block (auth/actions/triggers) + `secret_scope` field. Additive only — `data-source` and `artifact-store` are dropped later (C5/D2) once consumers are migrated, so typecheck stays green at every boundary.
- Synced the code-derived docs gate: `CAPABILITIES.md`, `METADATA.md`, `FACULTIES.md`, `CLAUDE.md`, `tests/faculties.test.ts`, `tests/docs-consistency.test.ts`.
- Verified: `npm run typecheck` clean; 78/78 across faculties+docs-consistency+metadata+capabilities+seed.

## Connector executor contract (established in C1, reused by C2-C4)
Each connector Fitting ships `scripts/connector.mjs` with a uniform CLI:
- `--probe` → prints `connectorOk` (verify hook; needs NO live secrets).
- `catalog` → JSON `{ service, auth, actions[] }`.
- `call <action> [argsJson]` → JSON `{ ok, result }` or `{ ok:false, error, awaiting_connector }`.
Secrets arrive SCOPED via env. For **api_key** connectors (trello) the engine materializes the `secret_scope` secrets. For **oauth2** connectors (google) the Automations engine (E2) calls `vault.getAccessToken(<service>)` (auto-refresh) and injects `<SERVICE>_ACCESS_TOKEN` into the call's env — OAuth refresh stays in the vault (TS), the connector.mjs just uses the token. `runAction({action,args,env,fetchImpl})` is exported so it's unit-testable with a mock fetch. A connector with missing creds throws `awaiting_connector:true` → the engine pauses with a "Connect <service>" deep-link (G2s).

## Gate calibration for this build (honest, logged per "no silent caps")
Scope is 23 slices. Calibration:
- **Correctness gate (committed tests + typecheck + build/lint) — EVERY slice, non-negotiable.**
- **Codex cross-model review — the substantive logic/security slices** (A1/A2 vault, B1 scheduler, E2 engine, F1/F2 browser+orchestration, G1s fixer, Z1 e2e). For purely mechanical slices (S1 vocab, C5 migration, F3 deletion) the deterministic, code-derived test suite is the gate; codex review of those is batched into the group review. This is logged, not silent.
- **Design audit + walkthrough — UI slices** (C6, D1, E3, G2s, H1) and the **Z1 end-to-end proof** (the headline evidence artifact).
