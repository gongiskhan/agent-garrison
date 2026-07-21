I'll investigate the routing config and tier classifier. Let me start broad with several parallel searches.
Found the key file: `src/lib/model-router.ts`. Let me explore it and the classifier in parallel.
Now let me find the actual routing.json config file, the classifier fixtures/tests, and the gateway dispatch mechanism.
There are two routing schemas. The newer one lives in `fittings/seed/orchestrator/`. Let me map that whole fitting - it's the real migration surface.
This V2 config is the real migration surface. Now let me read the resolution/classifier core and find every by-name target reference across the codebase.
Now let me read the V2 policy core, the live compiled policy, and how the classifier is invoked at the gateway.
Now let me look at how the classifier is invoked at the gateway, the Stage B, and the fixtures (matrix-harness).
The classifier lives in `gateway-routing.mjs`. Let me read its core dispatch mechanism and the fixture-driven tests in parallel.
Let me examine the matrix-harness (a fixture-driven test) and search for message→expected classification fixtures.
The matrix-harness is about runtime-agnosticism, not the tier classifier. Let me find the actual message→classification golden fixtures in the routing tests.
Let me confirm the live compiled policy, the discipline `review-by:` references, and the test command.
Let me capture the live composition source config (the actual authored config driving the running app) target set and profiles.
I have comprehensive evidence for both findings. Here is the structured report.

---

# FINDING-E3 — The routing config (post-V1)

There are **two schema generations** in the tree; the **v2 (target-based)** one is active. The v1 (role-based) one is legacy but still physically present and is the migration's "before" picture.

## (0) The config generations and where each lives

| Layer | File | Schema | Status |
|---|---|---|---|
| Old TS router | `src/lib/model-router.ts` | v1, `native-model`/`skill`/`workflow`/`ollama` targets, `taskType×tier→target` matrix directly | **superseded**, still compiled/tested (`tests/model-router.test.ts`) |
| v1 seed | `fittings/seed/orchestrator/routing.json` | v1 role-based (`roleMap`) | legacy; kept for migration tests |
| **v2 seed (SOURCE OF TRUTH)** | `fittings/seed/orchestrator/config/routing.seed.json` (728 lines) | **v2**, `runtime-target`/`secondary` targets, matrix→target | **active seed** |
| v2 pure core | `fittings/seed/orchestrator/lib/policy-core.mjs` | v2 implementation | active |
| v1/shared core | `fittings/seed/orchestrator/lib/routing-core.mjs` | delegates to policy-core when `version===2` | active |
| **Live authored config** | `compositions/default/.garrison/routing.json` | v2, **drifted from seed** | **what actually runs** |
| **Live compiled policy** | `compositions/default/.garrison/policy.json` + `~/.garrison/orchestrator/policy.json` (written 07-13 08:13) | compiled consumption interface | **runtime-active** |
| v1 backup | `compositions/default/.garrison/routing.json.v1.bak` | v1 | archived |

Key insight for the migration: **the live config has drifted far from the seed.** Do not migrate only the seed — the authored config `compositions/default/.garrison/routing.json` has extra targets (`sol`, `fable`, `opus-high`, `sdk-ollama-*`), a **4th `build` profile**, and different exceptions.

## (a) TARGETS — where defined, and where EFFORT is baked into identity

Effort is baked **both into the target id name AND as a `.effort` field** — the redundancy is exactly the migration surface (`target-with-effort → target(engine-only) + effort-in-cell`).

**v2 seed targets** (`config/routing.seed.json:87-201`), TypeScript/JS shape in `runtime-selection.ts:209-218` (`RouterTarget`) and the parser types in `model-router.ts:37-48`:
- `cc-fable-xhigh` (claude-code / fable / **xhigh**)
- `cc-opus-high` (claude-code / opus / **high**)
- `cc-sonnet-high` (sonnet / **high**)
- `cc-sonnet-med` (sonnet / **medium**)
- `cc-haiku-low` (haiku / **low**)
- `agent-sdk-haiku-fast` (agent-sdk / claude-haiku-4-5 / low)
- `cc-ollama-qwen`, `cc-ollama-deepseek` (claude-code / ollama-local)
- `sec-gemini`, `sec-codex` (type `secondary`)
- `codex-gpt55-high` (secondary / codex / gpt-5.5 / **high**)
- `classifier` (claude-code / haiku / low, **`pinned:true`**)
- `sdk-ollama-probe` (agent-sdk / ollama)

**Live authored targets** (`compositions/default/.garrison/routing.json`, dumped verbatim) — the real drift, note effort-in-name again: `cc-haiku-low`, `cc-ollama-qwen`, `cc-ollama-deepseek`, `sec-gemini`, `sec-codex`, `classifier`(PINNED), `sdk-ollama-chat`, `sdk-ollama-build`, `cc-opus-high` (effort `low`!), `cc-sonnet-med` (effort `low`!), `sdk-haiku-low`, `sdk-ollama-probe`, `sol` (secondary/codex/gpt-5.6-sol/high), `fable` (claude-fable-5/high), `opus-high` (claude-opus-4.8/high).

**v1 legacy target names** (`fittings/seed/orchestrator/routing.json:225-295`, and `model-router.ts` schema): `native-haiku-low`, `native-sonnet-medium`, `native-opus-high`, `skill-gemini-cli`, `skill-gemini-api`, `skill-codex-cli`, `workflow-memory-consolidation`, `ollama-local`.

Target resolution logic: `policy-core.mjs:232-268` (`resolveTargetId`/`resolveRouteV2`), which returns `{targetId, type, runtime, provider, model, effort}` per cell in `compilePolicy` (`policy-core.mjs:494-564`).

## (b) TIER set — names and where hardcoded

**3 tiers: `T0-trivial`, `T1-standard`, `T2-deep`** (with `tierDefinitions` in `routing.seed.json:27-36`). The list is hardcoded in **four** places (all must change for a `tier→level` rename):
- `policy-core.mjs:38` — `export const TIERS = ["T0-trivial","T1-standard","T2-deep"]`
- `routing-core.mjs:76` — `export const TIERS = [...]`
- `model-router.ts:19` — `export const routeTiers = ["T0-trivial","T1-standard","T2-deep"]`
- `config.tiers` in every routing.json/seed

Task-type axis (the `taskType→duty` half of the migration): **20 task types** in v2 = 11 pipeline verbs + `probe-question` + 7 general kinds, defined at `policy-core.mjs:18-36` (`PHASES` + `GENERAL_TASK_TYPES` → `TASK_TYPES_V2`) and `routing.seed.json:5-26`. The old v1 set was 8 (`model-router.ts:8-17`: code/review/research/image/video/writing/ops/other).

## (c) Discipline blocks (per-tier / per-phase config)

Per-tier `{review, testing, evidence, distribution}` at `routing.seed.json:550-569`, resolved by `resolveDisciplineV2` (`policy-core.mjs:290-297`) with per-profile `disciplineOverrides`. The `review-by:<target-name>` form you flagged:
- **v2:** `"review": "review-by:default"` — `routing.seed.json:564`, `compositions/default/.garrison/policy.json:54`, and rendered into every soul prompt (`compositions/default/.garrison/souls/*.md:605`, `_orchestrator.md`, `assembled-system-prompt.md`).
- **v1 (by-name target):** `"review": "review-by:native-opus-high"` — `fittings/seed/orchestrator/routing.json:57` and `:203`.
- TS type: `` review: "none" | "self-review" | `review-by:${string}` `` at `model-router.ts:61`.

Related per-phase config: **phase→skill bindings** (`routing.seed.json:682-698`, task-type→`garrison-*` skill), **phasePlans** (`:613-658`), **workKinds** (`:659-681`), **continuations** (`:570-598`, `cont-plan`/`cont-report` with verbs store/ask/route/notify), **uxQa.severityThreshold** (`:707-709`), **coordination** (`:710-728`).

## (d) EVERY by-name target reference (the migration blast radius)

Full per-file count from grep over `*.ts|*.mjs|*.js|*.json|*.md` (excluding node_modules + installed apm_modules). Top of the list is the load-bearing surface:

- **Configs (must migrate):** `fittings/seed/orchestrator/config/routing.seed.json` (116), `compositions/default/.garrison/policy.json` (89), `fittings/seed/orchestrator/routing.json` (49, v1), `compositions/default/.garrison/routing.json` (authored), `fittings/seed/orchestrator/dist/main.js` (5, built UI bundle), `data/library.json` (1).
- **Prompts / souls (rendered, will re-generate on recompile):** `compositions/default/.garrison/souls/*.md`, `assembled-system-prompt.md`, `.apm/prompts/orchestrator.prompt.md`.
- **Tests asserting exact target ids (will break on rename):** `tests/gateway-routing.test.ts` (22), `tests/agent-sdk-runtime.test.ts` (22), `tests/routing-compiler.test.ts` (20), `tests/orchestrator-policy.test.ts` (18), `tests/mutation-killers.test.ts` (15), `tests/runtime-selection.test.ts` (12), `tests/opencode-runtime.test.ts` (12), `tests/gateway-agent-sdk-route.test.ts` (11), `tests/claude-chat-sanitize.test.ts` (11), `tests/composer-view.test.ts` (10), `tests/routing-telemetry.test.ts` (9), `tests/routing-stage-b.test.ts` (9), `tests/gateway-runtime-adapter-routing.test.ts` (9), `tests/e2e/orchestrator-view.spec.ts` (9), `tests/gateway-souls-hint.test.ts` (5), `tests/model-router.test.ts` (6), `tests/model-router-server.test.ts` (6), `tests/agent-sdk-route.test.ts` (6), `tests/probe-local-target.test.ts` (5), `tests/e2e/primary-runtime.spec.ts` (5), plus ~15 more with 1-4 each.
- **Runtime code (by-name logic):** `fittings/seed/http-gateway/scripts/gateway-pty.mjs` (2), `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs` (1), `fittings/seed/opencode-runtime/scripts/bridge.mjs` (2), `fittings/seed/agent-sdk-runtime/{scripts/probe-*.mjs,lib/providers.mjs,scripts/bridge.mjs}`, `fittings/seed/kanban-loop/lib/engine.mjs` (1), `fittings/seed/automations/lib/discuss.mjs` (1), `packages/claude-{pty,chat}/src/*` (4).
- **Scripts:** `scripts/probe-live-gateway.mjs` (8), `scripts/matrix-harness.mjs` (7), `scripts/probe-provider-launch.mjs` (2).
- **Walkthrough storyboards / autothing run archives:** `.walkthrough/storyboard-*.json` and `docs/autothing/runs/**` (historical, non-load-bearing).

---

# FINDING-E4 — The tier classifier

## (a) Where the classifier lives — mechanism

It is a **pinned, warm Claude Code haiku session** (NOT a src/lib module, NOT a static prompt file). It runs inside the gateway:

- **Session:** `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs`, class `RoutedGateway`. `classifierRuntimeId = "classifier"` (`:222`); checked out from the `MultiRuntimePool` at `start()` (`:260`) and re-checked-out if it dies (`:474-478`).
- **Model:** the `classifier` target — `claude-code / anthropic-plan / haiku / low / pinned:true` (`routing.seed.json:181-190`; live authored config marks it PINNED). The v1 config instead carried `pool.classifierModel: "haiku"` (`fittings/seed/orchestrator/routing.json:5`).
- **Pure prompt/parser code:** `routing-core.mjs` — `buildClassifierPrompt` (`:335-363`) and `parseClassification` (`:391-404`). These are deterministic and dependency-free; the LLM only classifies, **code resolves** the route.
- **Souls-mode (no warm LLM) path:** deterministic fallback in `fittings/seed/http-gateway/scripts/lib/autonomous-cards.mjs:36` and hint-honoring in `souls-route.mjs`.

## (b) Input / output contract

- **Input:** `buildClassifierPrompt(config, userPrompt)` renders a single-shot prompt listing every taskType, every tier + its definition, every exception's `when`, and asks for **single-line JSON only**; user task truncated to 4000 chars (`routing-core.mjs:335-363`).
- **Output (parsed + clamped):** `parseClassification(reply, config)` → `{ taskType, tier, matchedException, contextKind?, execution }` (`routing-core.mjs:391-404`). Clamps out-of-vocab `taskType→"other"`, `tier→"T1-standard"`; drops unknown `matchedException→null`; returns `null` only when no JSON at all. `execution` ("interactive"|"autonomous") was added (D8) but is **dropped at preRoute** (`gateway-routing.mjs:603`, D18 — execution now derived from the phase plan, not the classifier).
- **Deterministic fast-path:** `classifyByKeywords(message, config)` (`gateway-routing.mjs:199-208`) short-circuits the LLM when an exception declares `keywords` — immune to LLM drift.

## (c) FIXTURES — exact paths and case counts

There is **no message→tier golden-eval set** (classification is LLM-driven, so it isn't asserted deterministically). The fixtures instead pin the **pure prompt builder, the parser, and the deterministic resolver**. A new "Dispatcher" must match these:

| File | `it()` count | What it fixtures |
|---|---|---|
| `tests/routing-classify.test.ts` | **9** | `buildClassifierPrompt` contents + `parseClassification` clamping/extraction (clean JSON, prose-embedded, fenced block, unknown-exception drop, out-of-vocab clamp, null-on-no-JSON, classify→resolve composition) |
| `tests/orchestrator-policy.test.ts` | **19** | v2 matrix resolution goldens (e.g. `implement×T2-deep→cc-opus-high`, `resolveRoute` cell>row>column>default, exception `ex-image→sec-gemini`), migration, rails |
| `tests/gateway-souls-hint.test.ts` | **8** | `resolveSoulsHint`/`parseClassificationHint` goldens (`code×T2-deep→expert→cc-opus-high`; `review×T0-trivial→fast→cc-haiku-low`; out-of-vocab→null) |
| `tests/routing-compiler.test.ts` | 16 | compiled `{{routing}}` markdown |
| `tests/routing-stage-b.test.ts` | 19 | Stage-B target-switch decisions |
| `tests/mutation-killers.test.ts` | 26 | resolver edge/mutation coverage |
| `tests/routing-telemetry.test.ts` | 10 | decision-record logging |
| `tests/orchestrator-autonomy.test.ts` | 11 | `classifyExecution`/`isSignificantAutonomous` |
| `tests/tier-compare.test.ts` | 4 | `shouldRespawnForTier` (respawn only when **model** differs, not effort) — `fittings/seed/http-gateway/scripts/lib/tier-compare.mjs` |

The seed config the fixtures load: `fittings/seed/orchestrator/config/routing.seed.json` (via `readFileSync` in each test).

## (d) How it's invoked at dispatch + test command

**Dispatch chain** (`gateway-routing.mjs`):
1. `RoutedGateway.classify(message)` (`:551-576`) — keyword fast-path → else `buildClassifierPrompt` → `classifier.session.runTurn({message, timeoutMs:60_000})` → `parseClassification` (falls back to `{other,T1-standard}` on failure).
2. `RoutedGateway.preRoute(message, opts)` (`:579-644`) — honors an explicit in-vocab `{taskType,tier}` hint (Kanban board) else calls `classify`; then `this.core.resolveRoute(config, activeProfile, classification)` (`:607`), writes a `decisionRecord` to `decisions.jsonl` enriched with runtime/provider/model, and dispatches (agent-sdk / secondary / `applySwitch` Stage-B).
3. Phase-skills/run-engine consume the compiled policy directly via `resolvePhaseTarget(policy, phase, tier)` (`policy-core.mjs:568-572`) — no HTTP/LLM.

**Test command:** `npm test` (= `vitest run`, per `package.json`); single file e.g. `npm test -- tests/routing-classify.test.ts`. There is also a config self-check: `fittings/seed/orchestrator/scripts/check-routing.mjs --check` (validates + compiles the v1 `routing.json`; the v2 path validates via `validatePolicyConfig` in `policy-core.mjs:356-473`).

## ~/.garrison/ router config files (as requested)

No `router.json`/`targets.yml`. The live runtime router config is:
- `~/.garrison/orchestrator/policy.json` (22,955 bytes, written 2026-07-13 08:13) — the compiled consumption interface the gateway reads.
- `~/.garrison/orchestrator/routing.json` (16,961 bytes) — the authored source.
- `~/.garrison/ui-fittings/model-router.log` — the router's own-port UI log.
- Source-of-truth copies also live at `compositions/default/.garrison/{routing.json,policy.json}` (filesystem is authoritative; `~/.garrison/orchestrator/` is the materialized runtime copy).

**Migration note:** the live `~/.garrison/orchestrator/policy.json` target set (`cc-haiku-low, cc-ollama-*, sec-gemini, sec-codex, classifier, sdk-haiku-low, sdk-ollama-{build,chat,probe}, cc-opus-high, cc-sonnet-med`, plus authored `sol/fable/opus-high` and a **`build` profile**) differs from the seed — any `(task-type,tier)→(duty,level)` + effort-in-cell migration must transform **the live authored `compositions/default/.garrison/routing.json` and all four profiles (balanced/economy/premium/build)**, then recompile, not just the seed.
