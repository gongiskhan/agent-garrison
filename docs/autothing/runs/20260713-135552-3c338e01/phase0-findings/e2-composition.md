I'll explore the composition file surface systematically. Let me start by mapping the composition directories, the metadata parser, and the dispatch-affecting config in parallel.
Let me dump the main composition file plus the dispatch-related config files.
The composition shape is clear. Let me read the full policy/routing config and start mapping the parser.
Now let me map the readers/writers of the composition file and the routing/policy config. Let me search comprehensively.
Critical finding: there's a documented "config split-brain" for routing.json across three locations. Let me read the core composition reader and the runner's routing resolution, plus hunt for schema versioning and migration code.
Let me read the runner's routing resolution and the active-composition pointer mechanism.
Let me check the composition-scoped routing.json, how it's written, the modes config, and the runner's env-var wiring for dispatch.
Let me confirm the modes config, the policy path resolution, migration code, and whether a local-overlay exists.
I have complete evidence for both findings. Here is the structured report.

---

# FINDING-E2 — The composition file today

## (a) Composition dirs + full shape of the active one

**Composition dirs** (`compositions/`): `default`, `dogfood-orch`, `e2e-solo`, `router-v4`, `secondary-minimal`. The **active pointer** is `~/.garrison/config.json` `active_composition` (defaults to `"default"` — `src/lib/active-composition.ts:37-53`). `default` is the live one.

**`compositions/default/apm.yml` is an APM manifest with a single `x-garrison.composition` block.** Top-level keys are plain APM: `name`, `version: 0.1.0` (APM package version, **not** a schema version), `target: claude`, `dependencies.apm[]` (30 `{path: ../../fittings/seed/<id>}` entries). Everything Garrison-specific is under `x-garrison.composition`:

- `id`, `name`
- `global_config`: `projects_root`, `vault`, `platform`, `guardrails{max_tasks_per_tick, max_spend_per_day, max_tool_calls_per_tick}`, `permissions_mode`, `observability_config{log_sink}`
- `selections`: keyed **by faculty role** (`orchestrator`, `channels`, `gateway`, `runtimes`, `design`, `memory`, `observability`, `sessions`, `surfaces`, `modes`, `connectors`). Each is an array of `{id, config:{…}}`.
- `prompt_sources`: `{orchestrator: .garrison/prompts/orchestrator.md, soul: .garrison/prompts/soul.md}`

Full verbatim structure is in `compositions/default/apm.yml:1-191` (already dumped). Note what is **NOT** in the composition file today: no duty/work-kind definitions, no tier/level definitions, no routing targets, no provider references, no dispatch matrix — those all live in separate files (see E18).

## (b) Every module that reads/writes the composition file — exhaustive

**Core read/write library — `src/lib/compositions.ts`** (the only module that authors the `x-garrison.composition` block):
- `readComposition(id)` — `compositions.ts:126`
- `readCompositionWithDerivedTasks(id)` — `compositions.ts:267` (also runs `migrateSelectionsByFaculty`)
- `listCompositions()` — `compositions.ts:114`
- `writeComposition(id, {name,selections,globalConfig})` — `compositions.ts:136` (the sole writer of `apm.yml`; re-authors `dependencies.apm` + `x-garrison.composition` via `writeYamlFile`, `compositions.ts:178`)
- `ensureComposition` / `createManifest` / `manifestToComposition` — `compositions.ts:194,226,249`
- `CompositionManifest` interface (the parse shape) — `compositions.ts:74-95`
- `getCompositionManifestPath` — `compositions.ts:186` (`<dir>/apm.yml`)

**Validation/parse of selections — `src/lib/metadata.ts`**: `validateSelection` (called from `compositions.ts:337`); `x-garrison` fitting-side parser + `FACULTY_ALIASES` legacy remap at `metadata.ts:381-401`. (metadata.ts parses **Fitting** `apm.yml`, not the composition block — the composition block is parsed inline in `compositions.ts`.)

**Consumers that read via `readComposition*`:**
- `src/lib/runner.ts:12,135` — `up()`/`down()` load the composition (`readCompositionWithDerivedTasks`), then read `composition.directory`, `.selections`, `.globalConfig`
- `src/app/api/runtime/active/route.ts:3,15`
- `src/lib/document-store.ts:3,21`
- `src/lib/quarters-runtimes.ts:21,56-68` (READ-ONLY guard note there)
- `src/components/chrome/AppShell.tsx:248` — `PUT /api/compositions/[id]` is the UI write path → `writeComposition`
- API: `src/app/api/composition/switch/route.ts` (down→set pointer→up), plus the compositions CRUD routes under `src/app/api/compositions/`

**Pointer/selection (which composition is active) — `src/lib/active-composition.ts`**: `readActiveConfig`, `getActiveComposition`, `setActiveComposition`, `resolveCompositionPointer`, `resolveActiveComposition` — stored in `~/.garrison/config.json`, **not** in any composition file. Supports an external filesystem-path pointer (`external:true`, `active-composition.ts:74-119`).

**Content-hash provenance — `src/lib/run-evidence.ts:50-68`**: at `up()` the runner SHA-256s `apm.yml` and appends to `<dir>/.garrison/run-evidence.json` (`runner.ts:137-149`).

**Global composition (Quarters, separate file) — `src/lib/global-composition.ts:35,96`**: authors `~/.garrison/global-composition/apm.yml` — a *different* apm.yml (the `~/.claude` control plane), not a `compositions/<id>` one.

## (c) Where Fitting config VALUES live today

**Inline in the composition `apm.yml`**, at `x-garrison.composition.selections.<faculty>[].config` (e.g. `orchestrator.config.port: 7087`, `agent-sdk-runtime.config.provider: ollama-local`, `browser-default.config.viewport_width: 1600`). This is the authoritative store — `writeComposition` normalizes each selection to `{id, config: config ?? {}}` (`compositions.ts:341-354`). Config schema/defaults come from the Fitting's own `apm.yml` `config_schema` (`defaultConfigForEntry`, `compositions.ts:381`).

**NOT in the composition file — three other value stores:**
- **Secrets**: `compositions/<id>/.env` (mode 0600, materialized from the vault by `materializeEnv`, `vault.ts:375`). E.g. `DEEPGRAM_API_KEY` in `compositions/default/.env`.
- **Prompts**: `compositions/<id>/.garrison/prompts/{orchestrator,soul}.md` (referenced by `prompt_sources`); assembled to `.garrison/assembled-system-prompt.md`.
- **Runtime/dispatch config**: `compositions/<id>/.garrison/routing.json` + `policy.json`, and the modes fitting's `apm_modules/_local/modes/modes.json` (see E18). **These are the biggest migration surface** — they are dispatch-owning config that lives *beside* but *outside* the composition manifest.

---

# FINDING-E18 — Dispatch-affecting config audit

Everything below changes which model/target/tier/mode/runtime handles a message. **The headline problem: routing config exists in FOUR live, mutually-drifted copies and policy in TWO** — the runner itself calls this a "config split-brain" (`runner.ts:585-587`).

## The routing/policy split-brain (verified on disk, all different sizes/mtimes)

`routing.json` — **4 copies**:
| Path | Role | Reader | Verdict |
|---|---|---|---|
| `compositions/default/.garrison/routing.json` (15441b, **newest** Jul13 08:13) | composition-scoped source of truth | runner `resolveRoutingSection`/`resolvePrimaryFromPolicy`/`resolveProvidersList` (`runner.ts:1037,1060,1100`); written by orchestrator fitting `PUT /routing` (`fittings/seed/orchestrator/scripts/server.mjs:116,334-380`) | **canonical — fold into composition** |
| `~/.garrison/orchestrator/routing.json` (16961b) | machine-global default the fitting server falls back to | orchestrator `server.mjs` when `GARRISON_COMPOSITION_DIR` unset | **move/retire** (redundant with composition-scoped) |
| `fittings/seed/orchestrator/routing.json` (8915b) | resolved by `findRoutingConfigPath` (`model-router.ts:327-336`) | automations **plan** + **vision** API routes (`api/automations/plan/route.ts:42`, `api/automations/vision/route.ts:34`) | **BUG-shaped: these two API routes read the SEED fitting file, not the composition** — decorrelated from the runtime path |
| `fittings/seed/orchestrator/config/routing.seed.json` (17857b) | `SEED_ROUTING_PATH` fallback (`runner.ts:1027`) | runner when composition-scoped absent | keep as seed default only |

`policy.json` — **2 copies** (compiled artifact, not hand-authored):
| Path | Role | Verdict |
|---|---|---|
| `~/.garrison/orchestrator/policy.json` (22955b, **newest**) | the "ONE consumption interface" for the run engine + phase skills (`fittings/seed/kanban-loop/lib/policy.mjs:4`); compiled by runner from routing.json at assembly (`runner.ts:1152-1160`, default `garrisonDir()/orchestrator/policy.json` unless `GARRISON_POLICY_PATH`) | derived — **keep as compiled cache, regenerate from composition** |
| `compositions/default/.garrison/policy.json` (22221b, stale) | older compiled copy | derived, stale — drop |

**What routing.json/policy.json own (all dispatch):** `activeProfile` (balanced/economy/premium), `profiles.<p>.matrix` (taskType×tier → target — the core dispatch table), `targets[]` (runtime+provider+model+effort+authMode), `providers[]` (anthropic-plan/ollama-local/deepseek/zai — incl. `vaultKey` refs), `exceptions[]` (e.g. secrets→cc-sonnet-med, image→sec-gemini), `computeLadder`, `preRoute` on/off, `primaryRuntime`, `discipline`/`disciplineOverrides` (per-tier review/testing/evidence), `phases`, `phasePlans`, `workKinds`+`defaultWorkKind`, `phaseSkills.bindings`, `tierDefinitions`, `uxQa.severityThreshold`, `coordination` thresholds, `projects.<name>.profile`. **Verdict: MOVE the entire authored routing.json into the composition** — it is 100% dispatch config and is exactly the "duties/levels/targets/provider references" the composition v4 is meant to absorb. `policy.json` stays a compiled projection.

## Modes config — `apm_modules/_local/modes/modes.json` (dispatch-affecting)

`compositions/default/apm_modules/_local/modes/modes.json` (read by `souls.ts:159`, `orchestrator-placement.ts:162`). Owns: `defaultMode: gary`, per-mode `soulRef` + `faculties` + `runtime` flag + **`routingBias`** (`standard-toward-fast`/`expert`/`expert-then-standard`, with `floor`/`prefer`), `channelDefaults` (dev-env→joe, slack→gary, web→gary), `switching` (sticky/autoInfer). **routingBias directly biases which tier/target a message gets**, and channelDefaults picks the mode (hence soul + bias) per inbound channel. **Verdict: MOVE** — but note the composition already has a `modes` faculty selection (`modes.config.default_mode: gary`, `briefs_path`) that *duplicates* `defaultMode`. It lives under `apm_modules/` (an APM-installed dir, gitignored, machine-local) — the mode *definitions* should move into the composition; the install-dir copy becomes a projection.

## Other dispatch-affecting settings

- **`global_config.permissions_mode`** (composition, `apm.yml:47`) → `GARRISON_PERMISSION_MODE` (`runner.ts:1373`). Already in composition. **KEEP.**
- **`global_config.guardrails`** (`max_tasks_per_tick`, `max_spend_per_day`, `max_tool_calls_per_tick`) — gate whether/how much dispatch happens (secondary-minimal sets `max_spend_per_day:0` precisely to suppress the loop). Already in composition. **KEEP.**
- **Per-fitting `selections[].config`** with dispatch relevance: `agent-sdk-runtime.config{provider: ollama-local, model, promptMode, maxTurns}` (`apm.yml:81-86`) directly sets a runtime target's model/provider. Already in composition but **redundant with routing.json targets** — reconcile the two. **KEEP but dedupe against routing targets.**
- **Env vars threaded by the runner at spawn** (all *derived from* the composition/routing, not independent sources): `GARRISON_MODEL`, `GARRISON_PROVIDER`/`GARRISON_PROVIDER_LAUNCH`, `GARRISON_PRIMARY_ENGINE`, `GARRISON_SYSTEM_PROMPT_PATH`, `GARRISON_POLICY_PATH`, `GARRISON_ROUTING_CONFIG`, `GARRISON_SOULS_CONFIG`, `GARRISON_COMPOSITION_DIR`, `ANTHROPIC_BASE_URL` (`runner.ts:329,375,1156,1368-1466`; `fittings/.../check-routing.mjs:9`). **KEEP as derived** — no need to move, but `GARRISON_POLICY_PATH`/`GARRISON_ROUTING_CONFIG` env overrides are how the split-brain gets papered over today; a v4 with one owner removes the need.
- **Quarters `~/.claude/settings.json`** (`src/lib/settings.ts`) — carries model/permission defaults for the *user's own* Claude Code, but the Operative launch overrides model via `GARRISON_MODEL`/routing. Not a Garrison-composition dispatch source. **KEEP out of composition** (it's the real `~/.claude`, APM-owned).
- **`orchestrator/policy.json` `_effortWas` fields + `cc-opus-high.effort` downgraded to `low`** (`policy.json:724-741`) — evidence of live hand/tool edits to the compiled artifact that then drift from routing.json. Reinforces "policy must be compiled-only, never edited."

---

# Schema versions, migration code, local-overlay

**Schema version markers:**
- **Composition manifest has NO schema version** for the `x-garrison.composition` block — only the APM package `version: 0.1.0`. Confirmed: no `schema_version`/`schemaVersion`/`apiVersion` anywhere in `compositions/` or the parser. This is a gap for a v4 migration.
- **routing.json / policy.json ARE versioned**: `version: 2` and `policyVersion: 2`. `isV2()` gates behavior in `routing-core.mjs:122,176,297,408`.

**Existing migration code:**
- **Composition**: only `migrateSelectionsByFaculty` (`compositions.ts:364-379`) — a *runtime self-heal* that re-buckets selections under their current faculty on read (handles the 2026-06-18 `sessions`→`sessions/runtimes/surfaces` split). Not a versioned migrator; no on-disk rewrite until next save.
- **Routing v1→v2**: real migrator `migrateRoutingConfig` in `routing-core.mjs:20,49`, applied at load; `PUT /routing` rejects v1 (`server.mjs:334` "v1 configs are migrated at load, not accepted on PUT"). Evidence a migration ran: `compositions/default/.garrison/routing.json.v1.bak` exists on disk.
- **Providers**: `ensureProviders` migration-seeds historical providers for pre-migration files (`runner.ts:1056-1077`).

**Local-overlay mechanism: does NOT exist for compositions.** There is no machine-local overlay file that sits beside the composition to hold host/port/path values. Machine-local dispatch state is instead handled ad-hoc by: (1) the `~/.garrison/config.json` active pointer, (2) `~/.garrison/orchestrator/{routing,policy}.json` as machine-global fallbacks, (3) `apm_modules/` and `.env` being gitignored/machine-local, and (4) env-var overrides at spawn. Ports/hosts are hardcoded **inline in the committed composition `apm.yml`** (`port: 7087`, `bind_host: 127.0.0.1`, `gateway_url: http://127.0.0.1:4777`, `outpost_host_url: http://127.0.0.1:3702`) — so today a second machine cannot vary ports without editing the committed manifest. `src/lib/claude-config-sync.ts:20` and `apm-manifest.ts:21` note "machine-local" only for `~/.garrison`, confirming there is no composition-side local overlay. **A composition v4 that "owns all dispatch config" will need a local-overlay layer** to keep machine-local ports/hosts/provider-baseUrls out of the shared manifest — this does not exist yet.
I've completed the exploration; both findings are fully gathered. Let me deliver them to the team lead via SendMessage.
Findings delivered to team-lead. Both are complete.

**FINDING-E2** — The composition is a plain APM `apm.yml` with everything Garrison-specific under one `x-garrison.composition` block (`id`, `name`, `global_config`, `selections` keyed by faculty role, `prompt_sources`). `src/lib/compositions.ts` is the only module that reads/writes that block (`writeComposition` at :136 is the sole writer). Fitting config values live inline in `selections[].config`; secrets in `.env`, prompts in `.garrison/prompts/`, and dispatch config in `.garrison/routing.json`+`policy.json` beside but outside the manifest.

**FINDING-E18** — The dispatch surface is a documented "config split-brain": `routing.json` exists in **4 live, drifted copies** (composition-scoped is canonical; the automations plan/vision API routes read a decorrelated seed copy — bug-shaped) and `policy.json` in 2 (a compiled artifact). The authored routing.json + the modes fitting's `modes.json` (`routingBias`, `channelDefaults`) are the config that should move into a composition v4; policy.json stays a compiled projection.

**Cross-cutting:** the composition manifest has **no schema version** (a v4 migration gap), the only existing composition migration is the runtime `migrateSelectionsByFaculty` self-heal, and **no local-overlay mechanism exists** — ports/hosts are hardcoded inline in the committed manifest, so a v4 owning all dispatch config will need a machine-local overlay layer.
