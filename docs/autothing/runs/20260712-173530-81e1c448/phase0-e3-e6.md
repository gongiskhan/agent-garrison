# Phase 0 exploration — runtimes + gateway state (FINDING-E3/E4/E5/E2)

Run 20260712-173530-81e1c448. Facts only, with file:line citations. Read-only exploration of `/home/ggomes/dev/garrison`.

## Q1 (FINDING-E3 — runtime state)

### What codex-runtime / gemini-runtime ship today (`fittings/seed/`)

- **`codex-runtime/`**: `apm.yml`, `lib/codex-adapter.mjs`, `scripts/bridge.mjs`. Provides `kind: runtime, name: codex`, `cardinality_hint: multi`, `component_shape: cli-skill`. Drives `codex exec` non-interactively, prompt via STDIN never argv (`codex-adapter.mjs:16` `buildExecArgs` → `["exec","-c",model=<id>,"--cd",dir,"--skip-git-repo-check","-"]`). Clean non-PTY adapter (no TUI scraping). `provider_mechanism: config-file` → `~/.codex/config.toml`, key `model_providers` (`apm.yml:36`). `quarters_descriptor.tier: generic` over `~/.codex` (config.toml / AGENTS.md / log + sessions). The bridge adds a **machine-wide O_EXCL serialization lock** (`codex.lock`, `bridge.mjs` `acquireCodexLock`/`releaseCodexLock`, GARRISON-UNIFY-V1 D14) because concurrent `codex` processes revoke the shared OAuth/API token; owner-pid + stale-break + bounded poll.
- **`gemini-runtime/`**: same shape (`apm.yml`, `lib/gemini-adapter.mjs`, `scripts/bridge.mjs`). Provides `kind: runtime, name: gemini`. `gemini --approval-mode yolo --skip-trust`, prompt via STDIN (`gemini-adapter.mjs:11` `buildArgs`). Positioned as **capability delegation incl. image** (there is no separate image skill; image role maps to `secondary:gemini`; `scrapeArtifactPaths` pulls image/pdf/mp4/svg paths from stdout, `gemini-adapter.mjs:96`). No serialization lock.
- Also present: **`claude-code-runtime`** (default PRIMARY; `provider_mechanism: env` ANTHROPIC_BASE_URL/AUTH_TOKEN; `quarters_descriptor.tier: deep`; provider select anthropic-plan/ollama-local/deepseek/zai-glm) and **`agent-sdk-runtime`** (secondary via Claude Agent SDK, no PTY; THE HARNESS full/lean promptMode; providers anthropic/ollama-local/zai-glm/deepseek/minimax/llm-proxy; `node_modules` vendored, `setup: npm install`).

### Runtime bridge `delegate(task_spec)` — core in `packages/claude-pty/src/runtime-bridge.mjs`

- **Task-spec schema**: `{ task (required string), paths[] (array), constraints (string|obj), model, expectedSchema, cwd }` plus agent-sdk extras `{ provider, promptMode, baseUrl, maxTurns, budgetTokens }`. `validateTaskSpec` (`runtime-bridge.mjs:29`); `parseTaskSpec` throws loud `DelegationError("invalid-json")` (`:44`). `model` validated against a per-runtime `modelAllowlist` regex: codex `/^(gpt-5|o[34]|codex|gpt-4)/i` (`codex-runtime/scripts/bridge.mjs`), gemini `/^gemini[-_.\d a-z]*/i`, agent-sdk per-provider.
- **Return schema**: `{ summary: string, artifacts: string[] }`, `validateDelegationResult` (`:57`). Full model output → Artifact Store (`writeArtifact("delegations", …)`, prefers the documents fitting's `ARTIFACTS_CLI`, else local file); return is schema-validated summary (600-char) + artifact paths; every call appended to `decisions.jsonl` via `logDecision`; retry-once-then-loud; `opts.requiredKey` distinguishes vault LOCKED vs secret ABSENT.
- **Transport is CLI, not MCP.** Module comment claims "The channel is MCP … this module is the bridge CORE the per-runtime MCP server + CLI wrap" (`runtime-bridge.mjs:2-11`), but **no MCP server exists in the repo** — the only implemented entrypoint per fitting is the CLI wrapper: `echo '<spec_json>' | node scripts/bridge.mjs delegate` (+ `--probe`), spec via STDIN or `--spec-file`.
- **RuntimeAdapter contract** (`packages/claude-pty/src/runtime-adapter.mjs`): `id`, `spawn`, `awaitReady`, `sendTurn`, `awaitResponse` (hardest primitive: turn-boundary detect + ANSI strip), `setModel`, `setEffort`, `resume`, `teardown`. Implemented by all four: `ClaudeCodeAdapter` (reference, `runtime-adapter.mjs:44`, wraps `OperativePtySession`), `CodexAdapter`, `GeminiAdapter`, `AgentSdkAdapter`. `runAdapterConformance` harness at `runtime-adapter.mjs:110`.

### GARRISON-RUNTIMES-V1 phase status

From `docs/autothing/runs/20260711-194226-168684d3/LANDING.md` + `RUN_SPEC.md`: **verdict passed, 8/8 slices, full-bar, final sentinel `GARRISON-RUNTIMES-V1 OK`**. All 8 DONE:
- S1 RUNTIME-CC-FIT-OK · S2 PROVIDERS-POLICY-OK · S3 PRIMARY-SELECT-OK · S4 PRIMARY-WIRED-OK · S5 QUARTERS-DESCRIPTOR-OK · S6 QUARTERS-CODEX-GEMINI-OK · S7 QUARTERS-SECTIONS-OK · S8 PROJECTION-PRIMARY-OK.
- Gates: typecheck/lint 0, full vitest 1972 passed/0 failed, isolated build green, mutation 8/8 killed, Codex checkpoint clean.

**OPEN (LANDING "Needs human eyes", non-blocking):**
1. **D8 — a non-claude primary hosts a working operative session for prompt delivery, but the interactive turn path (slash-inject / respawn) still assumes a Claude PTY.** It now degrades LOUDLY (`route-switch-skipped` log) rather than crashing. Full non-PTY turn wiring is explicitly future work ("the P8 slice"), flagged by the S4 review.
2. **agent-sdk prompt read-timing**: assembled prompt is read to bytes at gateway warm time (vs claude-code's file-path re-read); a mid-run soul reassembly keeps stale bytes on an agent-sdk primary.
3. 33 commits on local `main`, unpushed.

RUNTIMES-V1 is documented ONLY under `docs/autothing/runs/20260711-194226-168684d3/` — not in `docs/DECISIONS.md` or `docs/GARRISON_ROADMAP.md`.

### "Primary-runtime selection from the composer" — EXISTS

- `src/lib/runtime-selection.ts`: `resolvePrimaryRuntime` (`:72`), `buildPrimaryRuntimeEnv` (`:129`), `deriveRuntimeTargets` (`:228`), `mergeRuntimeTargets` (`:257`), `DEFAULT_PRIMARY_RUNTIME = "claude-code-runtime"` (`:14`).
- Composer UI: `src/components/compose/FacultyStation.tsx:770` (`primary_runtime` label + Primary picker; "validates against the installed runtime fittings").
- Policy file carries `primaryRuntime`. Orchestrator server owns it: `fittings/seed/orchestrator/scripts/server.mjs` exposes `GET /runtime-fittings` (`:674`, feeds the picker with installed/uninstalled flags) and returns **422 on PUT for an uninstalled primaryRuntime** (`:349-359`).
- At warm time the gateway resolves the policy-named engine as the operative: `resolvePrimaryAdapter` (`http-gateway/scripts/lib/gateway-routing.mjs:820-861`), throwing loudly if the named codex/gemini/agent-sdk fitting isn't installed. `GARRISON_PRIMARY_ENGINE` env / `primaryEngine` opt, default claude-code (`:888`).

### "Quarters per-runtime descriptor composition + single/multi collapse rule" — EXISTS

- `src/lib/quarters-runtimes.ts`: `resolveRuntimeQuarters` (`:55`) reads each selected runtime's `x-garrison.quarters_descriptor` → `tier: "deep"` maps to a registered route base (`DEEP_QUARTERS_REGISTRY`, `:28`; claude-code untouched) or `tier: "generic"` (descriptor-rendered surface, path-confined file I/O — reads/writes only the declared files, sha-guarded). API: `src/app/api/quarters/runtimes/route.ts` (`GET`, calls `resolveRuntimeQuarters`).
- Collapse rule: `src/components/quarters/QuartersIndex.tsx` `const multi = sections.length > 1` (`:103`). Single runtime (common: claude-code) → its surface renders **expanded**, current look preserved (`!multi ?` branch, `:130`). More than one → every runtime is a collapsible section, **ALL start collapsed** (`:98-101`). State persisted in `localStorage["quarters.sections.expanded"]` (`EXPAND_KEY`, `:29`).

## Q2 (FINDING-E4 — gateway's three Claude-specific mechanisms)

Active routed gateway: `fittings/seed/http-gateway`. Routing cores dynamically imported from `fittings/seed/orchestrator/lib/{routing-core,routing-telemetry,stage-b}.mjs` (`gateway-routing.mjs:167-170`). `mcp-gateway` is the separate disk-check/tools variant.

**(a) Classifier session — EXISTS · Claude-Code-specific · NOT abstracted.** `RoutedGateway.start()` checks out a pinned warm `classifier` session (`gateway-routing.mjs:254`). Stage A `classify()` (`:532`): deterministic keyword fast-path first (`classifyByKeywords`, `:199`), else one `runTurn` on the classifier session (`:545`), parsed by `core.parseClassification`. **Hardwired to a claude-code haiku session regardless of primary**: `createRoutedGateway` comment "The CLASSIFIER always stays on the cheap claude-code haiku session regardless of primary" (`:887`); `classifierSpawnConfig.model = "haiku"` (`:881`) on `claudeAdapter` which is always a `ClaudeCodeAdapter` (`:897`, `{ id: "classifier", adapter: claudeAdapter, role: "secondary", size: 1 }` `:904`). No non-Claude abstraction. `ensureClassifier` re-checkout on death (`:456-460`).

**(b) Slash-inject "Stage B" moves — EXISTS · Claude-Code-specific · guarded, not abstracted.** Stage B `applySwitch()` (`gateway-routing.mjs:629`) uses pure `planSwitch` (`stage-b.mjs:104`): model/effort differ + same provider/soul → **slash-inject** `/model`+`/effort` between turns via `operative.session.writeKeys(inj + "\r")` (`:646-648`); provider/soul differ → respawn-resume (`:651`). **D8 guard (S4 review):** if `operative.session.writeKeys` is not a function, it logs `route-switch-skipped` and skips (`:638-644`) — "model/effort stay launch-fixed until the P8 non-PTY turn wiring" — rather than crash with a TypeError. `ClaudeCodeAdapter.setModel/setEffort` also slash-inject (`runtime-adapter.mjs:75,80`, "MR0e verdict: works"). Not abstracted for non-Claude runtimes.

**(c) Resume semantics — EXISTS · Claude-Code-specific.** Respawn-resume (`respawnOperative`, `gateway-routing.mjs:663`) uses `buildRespawnOpts` (`stage-b.mjs:158`) with `continueSession: true` → `session.mjs:77` pushes **`--continue`** (never `--resume <id>` — comment: `--resume` unreliable for ephemeral 2.1.x sessions with no readable transcript, `session.mjs:63-65`). Because `--continue` may not restore ultra-short sessions, `buildContextCarryover` (`stage-b.mjs:145`) re-injects a compact recent-turns summary as the next turn's preamble after a respawn (`gateway-routing.mjs:620-624`, `_respawned` flag). `providerLaunch` keeps ANTHROPIC_BASE_URL/AUTH_TOKEN for non-anthropic-plan targets (`stage-b.mjs:169`). This is Claude-CLI-flag-specific. Note: agent-sdk targets run on their OWN adapter path (`runAgentSdkTurn`, `:284`) with SDK-native resume — one warm session per `{provider,model,promptMode}`, `_agentSdkSessions` map — and never touch the PTY operative switch.

## Q3 (FINDING-E5 — warm session pool tagging)

**There is no literal `attended` field.** Two-level tagging:
- `packages/claude-pty/src/warm-pool.mjs` `WarmPtySessionPool`: idle/pool spares in `this.available` (array), in-use in `this.checkedOut` (Map). Per-record status field **`state: "checked-out" | "available"`** (`warm-pool.mjs:64`). Record fields: `id, session, reason, turns, spawnedAt, lastUsedAt` (`#spawnRecord`, `:147`). `checkout()` (`:37`) moves available→checkedOut and immediately `#spawnReplacement` to keep a warm spare; `#release` (`:105`) returns it to available or disposes on `maxTurns`/dead/closed/over-size; `sweepIdle` disposes idle sessions past `idleTimeoutMs`.
- `packages/claude-pty/src/multi-runtime-pool.mjs` `MultiRuntimePool`: one `WarmPtySessionPool` per runtime, each tagged **`role: "primary" | "secondary"`** (`:37`; default warm sizes primary 2 / secondary 1, `:29`; global `maxTotal` cap), surfaced in `status()` as `{ role, ...pool.status() }` (`:50`).
- In practice the "attended" sessions = the gateway's long-held checkouts: `operative` (role `primary`, size 1) and `classifier` (role `secondary`, size 1), checked out once at `RoutedGateway.start()` (`gateway-routing.mjs:253-254`) and held for the session lifetime; the pool's `available` records are the idle warm spares. Pool config in `createRoutedGateway` (`gateway-routing.mjs:898-906`), read via `pool.checkout(id)` and `#alive` re-checkout (`:445-460`). `SessionRegistry` (`http-gateway/scripts/lib/session-registry.mjs`) tags souls/orchestrator sessions by `mode/status/soul/channel/parentSessionId/tier/terminalTabId` — also no `attended` field.

## Q4 (FINDING-E2 partial — limit banners)

**No — the gateway/claude-pty does NOT parse Claude Code's usage-limit / reset banners into structured values.** The status-line-embedded limit text exists only as fixture chrome that is deliberately discarded:
- Claude Code prints the limit on the RIGHT segment of the status line. Fixture: `tests/claude-pty.test.ts:143` → `"  myproj | 14% | Sonnet 4.6@high          You've used 93% of your weekly limit"`. Screen doc comment names the shape `"<name> | <ctx>% | <model>  …limit…"` (`packages/claude-pty/src/screen.mjs:17`).
- `parseStatus` (`screen.mjs:106`) **parses only the LEFT segment**: `statusRow.split(/\s{2,}/)[0]` (`:123`) → `contextPct` + `model` only. `STATUS_LINE = /\|\s*\d+%\s*\|/` (`:37`) matches the context-% only. The full row is kept verbatim in `statusRow`/`rows` for a UI status strip, but the "…% of your weekly limit" text is never parsed, regex-matched, or acted on.
- No "resets at" / "limit reached" / "5-hour" / "resets in" / "weekly limit" banner regex or reset-time parsing anywhere in `packages/claude-pty`, the gateways, or `src/lib`. Repo-wide sweep: the only `weekly limit` string is the one test fixture; `src/lib/claude-settings-schema.json:1755` mentions `rate_limit` only as a hook error-type enum (unrelated to PTY banner parsing). The sole test assertion on that fixture is that `extractReply` EXCLUDES it as chrome (`claude-pty.test.ts:156`).

## Key files
- `packages/claude-pty/src/{runtime-bridge,runtime-adapter,warm-pool,multi-runtime-pool,session,screen}.mjs`
- `fittings/seed/{codex-runtime,gemini-runtime,claude-code-runtime,agent-sdk-runtime}/`
- `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs`, `scripts/gateway-pty.mjs`, `scripts/lib/session-registry.mjs`
- `fittings/seed/orchestrator/lib/stage-b.mjs`, `scripts/server.mjs`
- `src/lib/{runtime-selection,quarters-runtimes}.ts`, `src/app/api/quarters/runtimes/route.ts`
- `src/components/quarters/QuartersIndex.tsx`, `src/components/compose/FacultyStation.tsx`
- `docs/autothing/runs/20260711-194226-168684d3/{LANDING,RUN_SPEC}.md`
