I'll investigate both findings. Let me start by reading the key files and searching for the probe generator in parallel.
Let me dig into runner.ts for the substitution and assembly logic, and use CodeGraph to trace the prompt path.
Let me read the full assembly logic in runner.ts and the gateway launch path.
Now let me find the 8KB cap and trace how promptPath reaches the gateway at launch.
The 8KB cap is a per-fitting validation in metadata.ts, not a runtime truncation. Let me confirm that and hunt the probe generator. Let me look at the monitor fitting and how the gateway consumes the prompt.
Several ollama candidates. Let me pin down the "probe generator" and who writes ollama.log, plus how the gateway consumes the prompt via souls config.
Found it: `fittings/seed/improver/scripts/probe-generate.mjs` is the probe generator. Let me read it fully and check the marathon dir on disk.
The probe generator itself uses template functions and resolves a model target from policy, but doesn't appear to call a model directly. The actual single-shot LLM call is likely in probe-core.mjs's target resolution or the runtime bridges. Let me trace those.
Two distinct "probe" concepts exist. Let me nail down the actual raw model-call shapes (ollama.log shows `/api/generate` calls) and the base-URL fence logic. Let me search for who calls the raw endpoints and how the adapter sets the ollama base URL.
The core seed is `providers.mjs` (Anthropic-compatible endpoint table + `buildSdkEnv` fence). Now let me read the single-shot delegate bridge (D14) and the claude-code `buildLaunchEnv` path to complete the call-shape picture.
Let me read the `buildLaunchEnv` fence in stage-b.mjs to complete the claude-code provider-swap path.
Let me confirm how the gateway consumes the prompt (souls config) and whether any locked/generated-block markers already exist in prompt assembly.
Let me read the runner `up()` spawn wiring to confirm how the assembled prompt reaches the gateway.
I have complete evidence for both findings. Here is the structured report.

---

## FINDING-E5 — Orchestrator prompt assembly today

### (a) The `{{capabilities}}` and `{{routing}}` substitution path

**Two callers share one pair of pure substitution functions in `runner.ts`:**

The runtime path is `assembleSystemPrompt()` at `src/lib/runner.ts:950-999`. It:
1. Reads the orchestrator prompt from the selected `orchestrator`-faculty fitting's `.apm/prompts/*.prompt.md` (`readPromptForFaculty`, `runner.ts:1243-1259`), falling back to `<compositionDir>/.garrison/prompts/orchestrator.md` (`runner.ts:954-957`).
2. Reads the identity/soul from `<compositionDir>/.garrison/prompts/soul.md` (`runner.ts:961-964`) — there is **no soul faculty**; identity is just a file folded in ahead of behavior.
3. Substitutes `{{capabilities}}` via `substituteCapabilitiesPlaceholder(orchestratorSource, entries)` (`runner.ts:975`, defined `1001-1010`).
4. Substitutes `{{routing}}` via `substituteRoutingPlaceholder(orchestrator, routingSection)` (`runner.ts:991`, defined `1082-1086`).
5. Concatenates `[fallbackSoul, "", orchestratorRouted]` — **soul first, behavior second** (`runner.ts:994`).

Both substitutions use **function-form `.replace(/{{x}}/g, () => block)`** deliberately, so `$`-patterns inside fitting-authored markdown aren't expanded as replacement directives (`runner.ts:1005-1009`).

- **`{{capabilities}}` feed:** `renderCapabilitiesBlock(entries)` (`runner.ts:1172-1241`). It runs the selected `LibraryEntry[]` through `resolveCapabilities`, then emits one sorted line per `provides` entry: `- <kind>:<name> — <summary>`, with each provider's `for_consumers` indented two spaces beneath (`runner.ts:1228-1240`). Empty → `_no Faculties currently installed in this Composition._`.
- **`{{routing}}` feed:** `resolveRoutingSection()` (`runner.ts:1095-1170`). Reads composition-scoped `<dir>/.garrison/routing.json`, falling back to the model-router seed `fittings/seed/orchestrator/config/routing.seed.json` (`runner.ts:1027`). It **dynamic-imports** the fitting's pure compiler `fittings/seed/orchestrator/lib/routing-core.mjs` (`ROUTING_CORE_PATH`, `runner.ts:1026`) with a `webpackIgnore` comment (`runner.ts:1138`) — without it Next compiles the dynamic import into an empty lazy-context module and the routing section silently goes empty (the documented "empty-`{{routing}}` incident", `runner.ts:1134-1137, 1162-1168`). It calls `validateRoutingConfig` → `compileRouting(config, activeProfile)`, and as a side effect recompiles the machine-readable `policy.json` via `compilePolicy` + `stableStringify` to `GARRISON_POLICY_PATH` or `~/.garrison/orchestrator/policy.json` (`runner.ts:1151-1160`).

Both placeholders are **loud on absence but never fatal:** `capabilitiesPlaceholderWarning` (`runner.ts:1015-1017`) logs `MISSING_CAPABILITIES_PLACEHOLDER_WARNING` if the prompt lacks `{{capabilities}}`; a `{{routing}}` placeholder with an unbuildable section logs `MISSING_ROUTING_CONFIG_WARNING` and strips cleanly to empty (`runner.ts:985-991, 1082-1085`) so the placeholder never leaks into the output.

**The projection path reuses the exact same functions.** `orchestrator-projection.ts:15` imports `substituteCapabilitiesPlaceholder, substituteRoutingPlaceholder` from `runner.ts`, and `buildOrchestratorInstructions()` (`orchestrator-projection.ts:56-64`) applies caps-then-routing over `inputs.orchestrator` and folds soul ahead — identical ordering to `assembleSystemPrompt`, so the RC3 rules-file and the runtime prompt share one substitution core.

### (b) `for_consumers` rendering and the "8 KB cap"

The aggregate rendering is in `renderCapabilitiesBlock` (`runner.ts:1172-1241`):
- Per-fitting `for_consumers` is read at `runner.ts:1183` (`entry.metadata.for_consumers?.trim()`), attached to every `provides` entry (`1184-1191`), and also **derived for view-only fittings** — a fitting with zero `provides` but a `ui.views[]`/`own_port` surface and a `for_consumers` block still gets one `view:<id>` line so its guidance reaches the Operative (`runner.ts:1198-1209`).
- **Fallback to `summary`:** the summary is `entry.metadata.summary?.trim() || entry.summary || entry.id` (`runner.ts:1182`); when a provider ships **no** `for_consumers`, only the header line is emitted (`runner.ts:1231-1233`). When *any* provider ships one, entries are separated by blank lines; otherwise the legacy single-line-per-provider form (`runner.ts:1226-1227`).

**Important correction on the "8 KB cap":** there is **no runtime truncation** in the assembly path. `renderCapabilitiesBlock` concatenates every provider's `for_consumers` **verbatim with no aggregate byte cap.** The 8 KB is a **per-Fitting schema-validation cap** in `src/lib/metadata.ts`: `FOR_CONSUMERS_MAX_BYTES = 8 * 1024` (`metadata.ts:50`), enforced at parse time by a Zod refinement `Buffer.byteLength(value,"utf8") <= FOR_CONSUMERS_MAX_BYTES` that rejects the manifest with `"for_consumers exceeds 8192 byte cap"` (`metadata.ts:283-286`). So the guarantee is "no single Fitting's `for_consumers` exceeds 8 KB," not "the assembled block is capped at 8 KB." For a locked-block design this matters: N fittings can each contribute up to 8 KB and the block grows unbounded in N.

### (c) Where the assembled prompt is written and how it reaches the gateway

- **Written to:** `<compositionDir>/.garrison/assembled-system-prompt.md` via `fs.writeFile` (`runner.ts:995-996`). `assembleSystemPrompt` returns that path.
- **In `up()`** (`runner.ts:202`) the path becomes `promptPath` and flows two ways:
  - **Gateway lane** (`spawnGateway`, `runner.ts:367-374`, def `1353-1437`): passed as env `GARRISON_SYSTEM_PROMPT_PATH: promptPath` (`runner.ts:1371`) plus `GARRISON_MODEL`/`GARRISON_PERMISSION_MODE`. If a `modes` provider is selected AND the mcp-gateway is present, `assembleSouls({ orchestratorPromptPath: promptPath, ... })` builds a per-soul config handed in as `GARRISON_SOULS_CONFIG` + `GARRISON_ORCHESTRATOR_FITTING_ID` (`runner.ts:208-244`); otherwise the gateway runs single-operative routed mode.
  - **Fallback lane** (`spawnClaude`, `runner.ts:381-385`, def `1439-1495`): same `GARRISON_SYSTEM_PROMPT_PATH: promptPath` env (`runner.ts:1462`) when no gateway fitting is selected.
- **Consumed inside the gateway fitting** (`fittings/seed/http-gateway/`): documented env contract in `scripts/gateway.mjs:16,26` (`GARRISON_SOULS_CONFIG`, `GARRISON_SYSTEM_PROMPT_PATH`, `GARRISON_MODEL`, `GARRISON_PERMISSION_MODE`). Delivery splits by engine:
  - **Agent-SDK primary:** the prompt is read as an **in-memory string** and passed as `systemPrompt.append` — `gateway-routing.mjs:916-945` reads `operativeSpawnConfig.appendSystemPromptFile` with `fs.readFileSync(promptFile)` (`:920-923`) and spreads `{ appendSystemPrompt }` into SDK options (`:945`).
  - **PTY/CLI primary:** `scripts/lib/spawn-soul.mjs:57,62` pushes `--append-system-prompt-file <promptPath>` onto the `claude` argv.

So the prompt is delivered per-launch via `--append-system-prompt(-file)` / SDK `systemPrompt.append`. The RC3 rules-file projection (`projectOrchestrator` → `~/.claude/rules/garrison-orchestrator.md`) exists but is **not called by `up()`** — confirmed: no call site in `runner.ts`; the only projection wired at launch is the per-primary context-file projection for `codex`/`gemini` (`orchestrator-projection.ts:167-209`).

### (d) Existing section-level structure (locked vs authored blocks)

**There is no locked/authored-block mechanism inside the orchestrator prompt itself today.** The assembled prompt is a flat concatenation: `soul.md` + blank line + orchestrator-with-placeholders-substituted (`runner.ts:994`). The only structural markers in the codebase are at the **whole-file/provenance** granularity, not intra-prompt sections:
- `PROJECTION_MARKER` (imported from `quarters-runtimes.ts` at `orchestrator-projection.ts:13`) marks an **entire projected file** (`AGENTS.md`/`GEMINI.md`) as Garrison-owned; `projectPrimaryContext` refuses to overwrite a file lacking it and reprojects one that has it (`orchestrator-projection.ts:185-200`). This is the closest existing precedent for "regenerate, never hand-edit."
- Echo-suppression **content hashing** via `recordWritten`/`hashFile` (`orchestrator-projection.ts:121-130`) detects whether an on-disk file is Garrison's own write vs an external edit — again whole-file, not per-section.

Net for the locked-block seed: the substitution functions already give you deterministic regeneration of `{{capabilities}}`/`{{routing}}` from the composition, and `PROJECTION_MARKER` is the existing "this region is generated, don't edit" convention — but neither carves the *inside* of the orchestrator prompt into locked vs authored regions. That structure does not exist yet.

---

## FINDING-E11 — The non-Anthropic local model-call path

There are **two distinct "probe" concepts**, and neither is the raw model caller you're seeding toward — the actual non-Anthropic call machinery is the **agent-sdk-runtime provider table + env fence**. Full breakdown:

### The two "probe" things (to disambiguate)

1. **Improver Probe generator** — `fittings/seed/improver/scripts/probe-generate.mjs` (+ `lib/probe-core.mjs`). This is a **Stop-hook feedback-question generator**, invoked by `probe-stop-hook.sh`. It does **not call any model.** It runs fail-closed gates, then builds probe questions from **templates** (`buildProbeQuestion`/`buildRetrospectiveQuestions`, `probe-core.mjs:166,224`) and emits a `{decision:"block", reason}` line so the Operative *relays* the question via `AskUserQuestion` (`probe-generate.mjs:14-16,178`). It only *resolves a model target* from the compiled policy's probe-question cell (`resolveProbeTarget`, `probe-core.mjs:250`; used at `probe-generate.mjs:117`) — for labeling/routing, never to make a call. So this is a red herring for "single-shot LLM call."

2. **agent-sdk-runtime live probes** — `fittings/seed/agent-sdk-runtime/scripts/probe-ollama.mjs`, `probe-chat.mjs`, `probe-raw.mjs`. These *do* hit a non-Anthropic model, and they are the closest existing single-shot callers.

### (a) Where the real call path lives

The non-Anthropic call substrate is `fittings/seed/agent-sdk-runtime/`:
- **Provider table:** `lib/providers.mjs` — `SDK_PROVIDERS` (`providers.mjs:22-92`).
- **Env builder / fence:** `buildSdkEnv` (`providers.mjs:135-176`) and `resolveProviderBaseUrl` (`providers.mjs:120-129`).
- **Single-shot delegate (D14):** `scripts/bridge.mjs` — `delegate(task_spec) -> {summary, artifacts}` over STDIN (`bridge.mjs:1-30`). This is the "invocable face" the runtime matrix exercises.
- A **parallel, older** table exists for the **claude-code TUI provider-swap** path: `fittings/seed/orchestrator/lib/stage-b.mjs` `buildLaunchEnv` (`stage-b.mjs:70-95`) and policy provider entries in `fittings/seed/orchestrator/lib/policy-core.mjs:64`.

### (b) How it calls the model — SDK, not raw fetch; **always the Anthropic Messages shape**

The critical design fact: **every non-Anthropic provider is reached as an "Anthropic-compatible endpoint," so the call shape is uniformly the Anthropic Messages API, not OpenAI-compatible or Ollama-native.** The mechanism is **env-based base-URL swap**, not a request-body rewrite:
- The Agent SDK / `claude` CLI is pointed at the endpoint via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_API_KEY` forced empty.
- `probe-raw.mjs:13` is the clearest minimal example: `env = { ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" }`, then `createSdkClient({ prompt, options })` streams SDKMessages (`probe-raw.mjs:39-48`). No `fetch`, no `/api/generate`.
- `probe-ollama.mjs` / `probe-chat.mjs` go through `AgentSdkAdapter` (`lib/agent-sdk-adapter.mjs`) with `provider: "ollama-local"`.
- **`buildSdkEnv`** (`providers.mjs:150-176`) is the strip-then-set fence: it `delete`s inherited `ANTHROPIC_API_KEY`/`BASE_URL`/`AUTH_TOKEN` (the MiniMax-precedence trap, `:157-160`), then for the Anthropic-subscription provider forces `ANTHROPIC_API_KEY=""` and no base URL (`:165-169`, so the SDK uses stored Max OAuth, never the API pool); for third parties sets `ANTHROPIC_BASE_URL=baseUrl`, `ANTHROPIC_API_KEY=""`, and the vault key (or dummy `"ollama"`) into `ANTHROPIC_AUTH_TOKEN` (`:171-175`).

Ollama's **native** `/api/generate` shape *does* appear in `~/.garrison/marathon/ollama.log` (POST `/api/generate` GIN lines) — but see the ollama.log note below; that is not the repo's call path. The repo talks to Ollama's **Anthropic-compatible** endpoint (v0.14.0+), commented at `providers.mjs:38-39`.

### (c) Call shapes supported

The provider table (`providers.mjs:22-92`) enumerates the supported endpoints, each with a **capability record** gating which content-block types may be routed there:
| provider | baseUrl | auth | capabilities |
|---|---|---|---|
| `anthropic` | null (Max OAuth) | subscription | FULL (text/tool/image/doc/webSearch/mcp) |
| `ollama-local` | `http://localhost:11434` | dummy `"ollama"` | text+tools+mcp |
| `zai-glm` | `https://api.z.ai/api/anthropic` | vault `ZAI_API_KEY` | text+tools+mcp |
| `deepseek` | `https://api.deepseek.com/anthropic` | vault `DEEPSEEK_API_KEY` | text+tools only |
| `minimax` | `https://api.minimax.io/anthropic` | vault `MINIMAX_API_KEY` | text+tools only |
| `llm-proxy` | **configurable per-target** | vault `LLM_PROXY_API_KEY` | text+tools (overridable) |

`llm-proxy` (`providers.mjs:83-91`) is the escape hatch: a per-target `baseUrl` fronting any model via a LiteLLM-style Anthropic-compatible proxy (OpenAI/Gemini/Qwen), with the model as free-text. `capabilityRecord`/`assertSupportsBlocks`/`assertRouteCapability` (`providers.mjs:180-230`) **refuse to route** an unsupported block (e.g. MCP or vision at DeepSeek) with a `CapabilityError` — a route-time gate you'll want to carry into a `garrison-call` fitting.

The delegate bridge validates the model string against a broad regex `MODEL_ALLOWLIST = /^[\w./:+-]{1,128}$/` (`bridge.mjs:29`), takes the task spec via **STDIN only** (never argv, `bridge.mjs:6-8`), and returns a schema-validated `{summary, artifacts}` with full output to the Artifact Store and the delegation logged to `decisions.jsonl` (`bridge.mjs:24-27`).

### (d) Base-URL allowlist / fence logic

There is **no free-form base-URL allowlist** — the fence is a **fixed named-provider table.** A caller cannot pass an arbitrary URL except through `llm-proxy`, and even then `resolveProviderBaseUrl` throws if `llm-proxy` has no explicit `target.baseUrl` (`providers.mjs:120-129`); unknown provider ids throw (`:122`). The real fences are:
1. **Env strip-then-set** in `buildSdkEnv` (`providers.mjs:150-176`) and the parallel `buildLaunchEnv` in `stage-b.mjs:70-95` — both delete inherited `ANTHROPIC_*` before setting, and force `ANTHROPIC_API_KEY=""` so a third-party base URL can never silently bill the Anthropic API pool. `stage-b.mjs:36-41` additionally rejects a malformed provider (no `kind`, no `baseUrl`) rather than defaulting to the Max plan.
2. **Provider-launch preservation flag:** a non-anthropic-plan target sets `providerLaunch: true` (`stage-b.mjs:169`) so the spawner keeps the base-URL env instead of scrubbing it back to the Max plan (the `session.mjs` scrub, referenced `stage-b.mjs:166-169`); mirrored in `runner.ts` `spawnClaude(..., providerLaunch)` → `GARRISON_PROVIDER_LAUNCH=1` (`runner.ts:1466`).
3. **Supply-chain version fence** (not a URL fence but adjacent): `LITELLM_FORBIDDEN = ["1.82.7","1.82.8"]` / `LITELLM_MAX = "1.82.6"` with `assertLitellmVersionAllowed` (`providers.mjs:233-262`) — blocks the compromised LiteLLM builds when the proxy is a LiteLLM install.

Note: providers are **policy data** (`stage-b.mjs:11-17`) — the hardcoded table in `stage-b.mjs` was removed; `buildLaunchEnv` resolves the spec from `opts.providers` (the compiled policy's `providers` section), and a missing/unknown provider is a **loud error, never a silent built-in fallback**. `providers.mjs` (agent-sdk) still carries a static table; the two have not been unified.

### ~/.garrison/marathon/ollama.log

**Nothing in the repo writes or reads it.** A repo-wide grep for `ollama.log`/`marathon/ollama` returns only docs about the GARRISON-MARATHON run and `RUN_LOG.md`. On disk (`~/.garrison/marathon/`) it is a **274 KB raw Ollama *server* stdout log** — GIN HTTP lines (`POST "/api/generate"`), llama.cpp slot/timing output, `model_recommendations.go` cache messages — i.e. the redirect target of an externally-launched `ollama serve` during the marathon, alongside the **uncommitted** `governor.mjs` (ccusage pacing tool, `MARATHON-PAUSED`/`RESUMED`) and `ledger.md`. `governor.mjs` does not reference the log either. So `ollama.log` is external run-time detritus, not a code-referenced artifact; the marathon's actual Ollama traffic went through the agent-sdk adapter's Anthropic-compatible path (matrix-harness `ollamaDelegate`, `scripts/matrix-harness.mjs:159-180`), while the `/api/generate` lines in the log suggest something also hit Ollama's native endpoint out-of-band (not via the repo).

**Key file refs for the garrison-call seed:** `fittings/seed/agent-sdk-runtime/lib/providers.mjs` (table + `buildSdkEnv` + capability gate), `fittings/seed/agent-sdk-runtime/scripts/bridge.mjs` (single-shot delegate contract), `fittings/seed/agent-sdk-runtime/scripts/probe-raw.mjs` (minimal SDK-over-ollama example), `fittings/seed/orchestrator/lib/stage-b.mjs:70-95` (`buildLaunchEnv` fence, policy-data provider resolution).
