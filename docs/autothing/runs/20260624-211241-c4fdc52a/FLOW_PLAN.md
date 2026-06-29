# Flow Plan — Runtimes as an essential Faculty (selectable engines + provider overrides)

Run: `20260624-211241-c4fdc52a` · Session `Goncalos-MacBook-Pro-b346309e` · Operator decisions: **promote runtimes to essential**, scope **delta + provider UI**, **sequence after f45c7c61** (their planning lock went stale; their INTENT still claims the collision-zone files).

## Context (already true in the repo — do NOT rebuild)
- `runtimes` faculty + `runtime` capability kind exist (`src/lib/types.ts`); faculty defs in `src/lib/faculties.ts` (runtimes ~L41, no `essential` flag yet).
- Existing runtime fittings: `agent-sdk-runtime` (has the `claude_code` preset harness `lib/harness.mjs`, THE FENCE `lib/fence.mjs`, `buildSdkEnv` `lib/providers.mjs`), `codex-runtime`, `gemini-runtime`. **No `claude-code-runtime` fitting yet.**
- Provider/base-url swaps exist: `fittings/seed/model-router/lib/stage-b.mjs` `PROVIDERS` = { anthropic-plan, ollama-local, deepseek, zai-glm } with baseUrl + vaultKey; `buildLaunchEnv()` (claude-code respawn) + `buildSdkEnv()` (agent-sdk).
- Router routes `runtime-target` entries (`config/routing.seed.json`, `lib/routing-core.mjs`); targets are **hand-seeded**, not derived from fitted runtimes.
- `up()` (`src/lib/runner.ts:216-238`) hardwires gateway-or-PTY as the orchestrator; own-port runtimes start as secondary delegates (`startOperativeBoundFittings`). No primary/secondary selection is implemented (only a doc comment).
- UI: `StationGrid.tsx:275-307` auto-groups essential vs optional on `faculty.essential`; `OrchestratorGlobalConfig` (`FacultyStation.tsx:756-859`) renders composition-level `GlobalConfig`; per-fitting config via `ConfigInput` (`FacultyStation.tsx:699-754`); `secret-ref` type defined but not rendered.

## Contract decisions (decided, not asked)
- **Primary runtime** lives at `GlobalConfig.primary_runtime?: string` (composition-level, owned by Orchestrator), persisted to `apm.yml` `x-garrison.composition.global_config.primary_runtime`. Default `"claude-code-runtime"`. `up()` resolves it; `claude-code-runtime` (or unset) → current gateway/PTY path (behavior preserved); `agent-sdk-runtime` → orchestrator via the agent-sdk harness.
- **Provider override** = per-runtime-fitting `config_schema` field `provider` (select: anthropic-plan/ollama-local/deepseek/zai-glm); the existing `PROVIDERS` registry resolves baseUrl + vaultKey, so the user picks a provider, not a raw URL. Optional advanced `base_url` (string). Vault key surfaced via a `secret-ref` input.
- **Claude Code Runtime Fitting** = new APM seed pkg `fittings/seed/claude-code-runtime/`, `faculty: runtimes`, `provides: runtime`, node-pty engine, `own_port: false`, `config_schema`: provider(select)+model(select opus/sonnet/haiku)+base_url(string). It makes the implicit default a first-class selectable peer. Registered (additively) in `data/library.json`.
- **Collision zone** (f45c7c61 intent — keep edits ADDITIVE; re-check `coord_digest` immediately before each): `src/lib/types.ts`, `faculties.ts`, `metadata.ts`, `capabilities.ts`, `data/library.json`, `src/components/compose/`, `fittings/seed/`. `src/lib/runner.ts` is mine (not in their intent).

## Slices

| # | Slice ID | Title | Kind | Routes to | Parallel group | Status |
|---|----------|-------|------|-----------|----------------|--------|
| 1 | cc-runtime-fitting | First-class Claude Code Runtime Fitting (node-pty engine, selectable peer) | mixed | garrison core (docs/architecture.md, METADATA.md) | A | passed |
| 2 | primary-runtime-spawn | Selectable PRIMARY runtime: GlobalConfig.primary_runtime + runner spawn resolution | mixed | garrison core (runner.ts) | B (after A) | passed |
| 3 | router-target-derive | Auto-surface fitted runtimes as model-router targets | mixed | garrison core (model-router) | B (after A) | passed |
| 4 | runtimes-essential | Promote `runtimes` to an essential Faculty (grid grouping) [COLLISION] | ui | compose UI | C (after A) | passed |
| 5 | runtime-provider-ui | Compose UI: primary-runtime selector + per-runtime provider selector (+secret-ref input) [COLLISION] | ui | compose UI | D (after B) | passed |

<!-- Status: pending | passed | passed | blocked. Mirror of each slice's gate-status.json. -->

## Acceptance per slice
- **cc-runtime-fitting**: `tsx scripts/validate-fitting.ts fittings/seed/claude-code-runtime` passes all four checks; the fitting parses (`metadata.ts`) with `faculty: runtimes`, `provides: [{kind: runtime}]`, and its `config_schema`; it appears as a selectable option under the Runtimes faculty in Compose (e2e through `/compose`). Committed test asserts metadata parse + library-entry presence. typecheck/build/lint clean.
- **primary-runtime-spawn**: `GlobalConfig.primary_runtime` round-trips through `apm.yml` (write/read). A committed unit/integration test proves the runner's primary-resolution fn returns the configured runtime (default `claude-code-runtime` → gateway/PTY path; `agent-sdk-runtime` → harness path) and that an unset value preserves today's behavior. No regression in existing runner tests. typecheck/build clean.
- **router-target-derive**: With a runtime fitting composed under `selections.runtimes`, `resolveRoutingSection()` yields a router target derived from it (id + runtime + provider) merged with seed targets, and `validateRoutingConfig` still passes. Committed test drives the derivation from a fake composition. typecheck/build clean.
- **runtimes-essential**: `/compose` renders **Runtimes** inside the "Every agent needs these" (essential) group; e2e-through-UI screenshot confirms placement. Committed test asserts `getFaculty("runtimes").essential === true`. typecheck/build/lint clean.
- **runtime-provider-ui**: On `/compose`, the Orchestrator global config shows a **Primary runtime** selector listing composed runtimes; selecting persists to `apm.yml`. A runtime fitting's config shows a **Provider** selector (anthropic-plan/ollama-local/deepseek/zai-glm); selecting a key-requiring provider surfaces a `secret-ref` vault input; selections persist. e2e through the UI + committed test. typecheck/build/lint clean.

## Parallelism
- **Group A** (cc-runtime-fitting) first — everything references the new runtime id.
- **Group B** (primary-runtime-spawn, router-target-derive) run concurrently after A — disjoint files (`runner.ts` spawn path vs `resolveRoutingSection`/model-router); serialize only the shared dev-serve/recorder/Codex.
- **Group C** (runtimes-essential) after A — collision-zone, re-check coord first; tiny edit.
- **Group D** (runtime-provider-ui) after B — depends on the primary-runtime backend + the new fitting's config_schema.
- Run-wide serial: one dev-serve / one bundle / one recorder, one `codex exec` at a time. Coordinate cross-session via coord-mcp (heartbeat the lock through planning; re-check intents before each COLLISION slice) + beads issues per slice.

## Global acceptance
Every slice: committed re-runnable e2e-through-UI test + clean typecheck/build/lint, same-model review clean, Codex cross-model review `approve` + Codex Playwright `pass`, design audit clean (UI slices), and a VERIFIED walkthrough video. Tracked in `<runDir>/evidence-index.json → globalGate`.

## Assumptions / open questions resolved by deciding
- **agent-sdk-as-primary depth**: v1 makes the *selection mechanism* real and correct; the default `claude-code-runtime` primary preserves today's gateway/PTY behavior exactly. `agent-sdk-runtime` as primary routes the orchestrator through the existing harness; if hosting the full interactive orchestrator loop on agent-sdk proves out-of-scope for one slice, the selection still resolves and is honored, and any unsupported combo fails loud (never silently falls back). Logged in `docs/decisions.md` if narrowed.
- **base_url vs provider**: user picks a `provider` (registry resolves baseUrl/vaultKey); raw `base_url` is an advanced override only. Avoids a free-text URL as the primary knob.
- **library.json / faculties.ts edits are additive** (append entry, add one flag) to merge cleanly with f45c7c61.
