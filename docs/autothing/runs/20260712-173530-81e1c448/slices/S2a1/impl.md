# S2a — route the gateway's three Claude-specific mechanisms through the RuntimeAdapter

Goal: the http-gateway's three Claude-specific mechanisms (Stage-B moves,
respawn-resume, classifier pinning) route through the `RuntimeAdapter` interface
so a non-Claude primary boots and serves sessions cleanly. The claude-code
primary path stays byte-for-byte identical.

## What changed

### 1. Stage-B moves via adapter — `applySwitch()`
`fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs:657-690` (adapter-moves
`675-676`, skip `679-684`)

The `slash-inject` branch used to hard-skip (log `route-switch-skipped`) the
moment `this.operative.session.writeKeys` was not a function (a non-Claude
session). Now, before skipping, it asks the operative's adapter
(`this.operativeAdapter()`): if it implements `setModel`/`setEffort`, the planned
moves are applied through `adapter.setModel(session, model)` /
`adapter.setEffort(session, effort)` — one call per entry in `plan.injections`,
with the model/effort values taken from `route.target`. It then updates
`this.currentTarget`, pushes `{ path: "adapter-moves", ... }` to `switchLog`, and
logs `{ kind: "route-switch", path: "adapter-moves", ... }`. The historical skip
(with its `route-switch-skipped` log and `skipped-non-pty` switchLog entry) fires
**only** when the adapter lacks those methods. The Claude PTY path (session has
`writeKeys`) is untouched — it still runs the `writeKeys(inj + "\r")` loop.

### 2. Resume via adapter — `respawnOperative()`
`fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs:704-738` (adapter
path, log `737`) and `:763` (new distinguishing log on the claude path)

When the operative adapter is non-claude (`adapter.id !== "claude-code"`) and
implements `resume`, respawn routes through `adapter.resume(config)` instead of
the claude-specific `spawnFn` + `buildRespawnOpts(--continue)` path. The config
mirrors the adapters' `spawn` shape (`compositionDir`, `provider`, `model`,
`effort`, `appendSystemPromptFile`, `secrets`, `permissionMode`) and carries the
prior `session.sessionId` for SDK resume. The old operative is torn down via
`adapter.teardown`. Logs `{ kind: "route-respawn", path: "adapter-resume" }`; the
existing claude path now logs `{ kind: "route-respawn", path: "spawn-continue" }`
so the two are distinguishable. Claude behaviour is otherwise unchanged.

### 3. Classifier fallback — `createRoutedGateway()` / `resolveClassifierAdapter()`
`fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs:944-1006` (helpers:
`claudeCodeResolvable` 944, `resolveClassifierAdapter` 988, `classifier-fallback`
log 1001), `:1009-1030` (wiring), `:1079` (`operativeAdapter: primary.adapter`)

New `resolveClassifierAdapter()`:
- **claude-code primary** → classifier uses `primary.adapter` (as before).
- **non-claude primary + claude-code resolvable** → classifier stays on a fresh
  `ClaudeCodeAdapter` with the haiku `classifierSpawnConfig` (byte-identical to
  the previous `primary.claude ? primary.adapter : new ClaudeCodeAdapter(...)`).
- **non-claude primary + claude-code absent** → falls back to `primary.adapter`
  with the primary's spawn config (`classifierFallbackConfig`, cheap model only
  when an override is supplied), logging loudly
  `{ kind: "classifier-fallback", from: "claude-code", to: <engine>, reason }`.

Resolvability is `claudeCodeResolvable()`: an explicit `opts.claudeCodeResolvable`
(boolean/function) wins; a stub `spawnFn` counts as resolvable (tests/dev);
otherwise a cheap PATH/`CLAUDE_BINARY` probe (`isClaudeBinaryPresent`, no spawn,
no deps). The claude-primary case short-circuits before any probe, so the common
path never touches the filesystem.

### Plumbing
- `packages/claude-pty/src/multi-runtime-pool.mjs:58-66` — new `adapterFor(runtimeId)`
  exposes the adapter backing a warmed runtime id (the "thread the adapter through
  the pool" requirement).
- `RoutedGateway` constructor stores `this._operativeAdapter` (injected from
  `createRoutedGateway` as `operativeAdapter: primary.adapter`); new
  `operativeAdapter()` accessor prefers the injected reference, else
  `pool.adapterFor(this.operativeRuntimeId)`, else null (treated as the Claude PTY
  path — safe default).

## Tests added
`tests/gateway-runtime-adapter-routing.test.ts` (6 tests):
- `S2a.1 … adapter WITH setModel/setEffort: a session without writeKeys takes adapter-moves, not the skip`
- `S2a.1 … adapter WITHOUT setModel/setEffort: the existing skip fires (regression guard)`
- `S2a.2 … a non-claude adapter with resume: adapter.resume is called and the claude spawnFn is NOT`
- `S2a.2 … a claude-code operative adapter takes the historical spawnFn path (regression guard)`
- `S2a.3 … non-claude primary + claude-code unresolvable → classifier-fallback logged, primary adapter classifies`
- `S2a.3 … non-claude primary + claude-code resolvable → classifier STAYS on claude-code (byte-identical default)`

All use injected fakes — no live CLI, no real model.

## Verification
- Failing-before/passing-after: stashing the two source files leaves the new test
  file at **4 failed | 2 passed** (the 2 that pass are the regression guards);
  with the change, **6 passed**.
- `npm run typecheck` → exit 0.
- `npx next lint` on the three touched files → "No ESLint warnings or errors".
- `npm test` FULL suite → **2007 passed | 13 skipped (2020)**, 235 files.

## Deviations from the brief
- **`route-respawn` on the claude path.** The brief said to log adapter-resume
  "vs the existing path". I added `{ kind: "route-respawn", path: "spawn-continue" }`
  to the existing claude path so the two are distinguishable in the log (loud over
  silent). `logFn` defaults to a no-op and no test asserts its absence, so the
  claude session's spawn/inject behaviour is unchanged — the extra diagnostic line
  is the only difference.
- **Adapter reference threading.** The pool checkout record does not carry the
  adapter, so rather than a breaking change to the record I (a) added
  `MultiRuntimePool.adapterFor()` and (b) threaded `operativeAdapter: primary.adapter`
  from `createRoutedGateway` into the gateway. `operativeAdapter()` prefers the
  injected reference and falls back to the pool accessor — both clean, no breaking
  change.
- **`plan.path` unchanged on adapter-moves.** `applySwitch` still returns the
  `planSwitch` result (`path: "slash-inject"`); only `switchLog` and the log entry
  carry `"adapter-moves"`, exactly as the brief scoped it. No gateway-pty consumer
  branches on the returned `plan.path`.
- **Classifier "cheap model".** The brief said "cheap model if the config allows".
  There is no reliable per-provider cheap-model map, so `classifierFallbackConfig`
  reuses the primary's spawn config verbatim and only lowers the model when an
  explicit `opts.classifierFallbackModel` override is supplied and the config has a
  `model` field.

---

# S2a2 — gated live smoke: agent-sdk primary over ollama serves a turn + adapter-moves switch

`tests/agent-sdk-primary-smoke.integration.test.ts` — a COMMITTED, gated live
smoke (pattern: `describe.skipIf(!LIVE)` on `GARRISON_INTEGRATION === "1"`, like
`codex-primary-smoke.integration.test.ts`). It boots the REAL `RoutedGateway`
with an **agent-sdk primary over the free local ollama-local provider**
(qwen2.5:3b, `promptMode: "lean"` for a fast pure-chat turn), then:
1. asserts the **classifier fell back** to the primary adapter (claude-code forced
   unresolvable via `claudeCodeResolvable: false`) — exercising S2a change 3 live;
2. **serves one real turn** on the operative's own adapter
   (`adapter.sendTurn`/`awaitResponse`) and asserts a non-empty ollama reply;
3. `applySwitch` to a different model+effort on the same agent-sdk runtime and
   asserts the switch took the **adapter-moves** path (change 1) with no
   `route-switch-skipped`, and that the adapter recorded the move on the live
   session (`session.model` / `session.effort` / `currentTarget`).

## Real output (GARRISON_INTEGRATION=1, one live run) — PASS
`1 passed`, 38.6s (< 90s budget). Captured evidence:
```
[S2a2] classifier-fallback: {"kind":"classifier-fallback","from":"claude-code","to":"agent-sdk","reason":"claude-code runtime not resolvable (CLI absent); classifying on the primary adapter instead of the cheap claude-code haiku session"}
[S2a2] ollama reply: "pong"
[S2a2] adapter-moves log: {"kind":"route-switch","path":"adapter-moves","injections":["/model qwen2.5:1.5b","/effort high"],"target":"ollama-switch","runtime":"agent-sdk"}
```
The qwen2.5:3b operative really answered ("pong"); the non-PTY switch really took
`adapter-moves` (not the old skip). Gated: skipped in the normal suite
(`npm test` = 2007 passed | 14 skipped).

## Real gateway bug found + fixed in this slice
Booting an agent-sdk primary over ollama surfaced that
`resolvePrimaryAdapter()` (`fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs:903-919`)
**hardcoded `provider: "anthropic"` and `promptMode: "full"`** for the agent-sdk
primary — so a non-Anthropic agent-sdk operative was impossible (it would have
billed the Anthropic Max endpoint instead of running on free local ollama). Fixed
to honor `operativeSpawnConfig.provider` / `.promptMode` (defaulting to
`anthropic` / `full` — byte-identical when unset, proven by the unchanged S4
`resolvePrimaryAdapter` tests) and thread the per-target `baseUrl` / `leanPrompt` /
`secrets` through to `AgentSdkAdapter.spawn`. This is the plumbing that makes "a
non-Claude primary serves sessions cleanly end-to-end" actually true off-Anthropic.
