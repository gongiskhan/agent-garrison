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
