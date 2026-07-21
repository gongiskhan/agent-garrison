# S2c — runtime-agnosticism matrix harness + full run (impl)

Run: `20260712-173530-81e1c448`
Slice: S2c (build + RUN the runtime-agnosticism test matrix: every Fitting in
`compositions/default` under each of three primaries — claude-code, codex, opencode)
Date: 2026-07-12

## Outcome

Every one of the 28 fittings in `compositions/default` was exercised under all
three primaries. **All three primaries boot the real `RoutedGateway` and serve a
live turn** (each replied `pong`); **ZERO unexplained failures** across 84 cells —
every non-pass carries a documented cause. One genuine agnosticism bug was found
and fixed in place (opencode could not run as a primary). The matrix is committed
at [`docs/RUNTIME_MATRIX.md`](../../../../RUNTIME_MATRIX.md); it is fully
re-runnable and re-renderable.

## Matrix summary (pass / degraded / verify-only / fail — boot row included)

| Primary | boot | pass | degraded | verify-only | fail |
| --- | --- | --- | --- | --- | --- |
| `opencode` | PASS (`pong`, 41.6s) | 16 | 2 | 11 | **0** |
| `codex` | PASS (`pong`, 5.8s) | 18 | 1 | 10 | **0** |
| `claude-code` | PASS (`pong`, 28.9s) | 16 | 2 | 11 | **0** |

The `codex` column has two more passes than the others: its budgeted
`codex-runtime` delegate ran real (PASS), and `opencode-runtime`'s delegate passed
there because ollama was not under concurrent load (see degradations).

## The agnosticism bug fixed in place

**opencode could not run as the PRIMARY engine.**
`fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs` — `resolvePrimaryAdapter`
had branches for `claude-code`, `agent-sdk`, and `codex`/`gemini` only, so a
composition naming `opencode-runtime` as its `primaryRuntime` failed loud with
`unknown primary engine "opencode"` — even though opencode is a first-class runtime
fitting (S2b) with a complete `RuntimeAdapter`. The uniform adapter contract is
exactly what should let a non-Claude primary boot regardless of engine, so the
omission was a gap, not a design choice.

Fix (commit `0f783ee`):
- `gateway-routing.mjs:837` — `KNOWN_PRIMARY_ENGINES` now includes `opencode`.
- `gateway-routing.mjs:846` — new `EXEC_PRIMARY_ADAPTER_CLASS` map
  (`{codex: CodexAdapter, gemini: GeminiAdapter, opencode: OpenCodeAdapter}`)
  generalises the old codex/gemini branch.
- `gateway-routing.mjs:950` — the exec-primary branch keys off that map (same
  `resolveSecondaryDir` + warm bridge-probe shape as codex/gemini).
- `gateway-routing.mjs:972` — OpenCode has no built-in default model and its native
  config may omit a top-level `model`, so a provider/model is threaded from the
  operative spawn config **only for opencode** (a bare non-`provider/model` value
  such as the `createRoutedGateway` `"sonnet"` default is intentionally NOT
  threaded — opencode then falls back to its own config default). codex/gemini keep
  taking their model from their own CLI config; their `spawnConfig` is byte-identical.

Unit tests (`tests/gateway-routing.test.ts`, same commit): opencode resolves via the
injected-adapter seam (`claude:false`); it threads `ollama-local/qwen2.5:3b` but not
a bare `"sonnet"`; codex ignores `operativeSpawnConfig.model`; the unknown-engine
loud-error test was repointed from `opencode` (now known) to `mistral-cli` and its
expected known-set updated to include opencode. This bug was then **proven fixed
live**: the opencode column boots the real `RoutedGateway(primary=opencode)` and
serves a turn over free local ollama.

## Harness design (`scripts/matrix-harness.mjs`)

Re-runnable and committed:
`node scripts/matrix-harness.mjs [--primary <id>] [--out <path>] [--cells <path>] [--render-only]`.

- **Columns.** Default runs `claude-code, codex, opencode`; `--primary <id>` runs a
  single column (also accepts `agent-sdk`/`gemini`). Results merge into a durable
  `matrix-cells.json` cache written after every column, so a single column can be
  re-run without repeating the budgeted codex calls, and `--render-only`
  regenerates the doc from cache.
- **Primary boot + served turn (`bootAndServe`, `scripts/matrix-harness.mjs:368`).**
  Boots the real `RoutedGateway` via `createRoutedGateway`, mirroring the S2a2
  integration smoke: claude-code on a haiku PTY; agent-sdk/opencode over free local
  ollama `qwen2.5:3b`; codex over its default model in an isolated `CODEX_HOME`
  (auth copied — the same hygiene the run's codex gates use). It serves ONE turn on
  the operative's own adapter (`sendTurn`/`awaitResponse`) and asserts a non-empty
  reply. A `withTimeout` race (`:360`) degrades a hung boot/turn gracefully so the
  fitting cells still run.
- **Per-fitting cell (`runCell`, `:246`).** For every fitting: run its
  `x-garrison.verify` hook (health — the `apm_modules/_local/<id>` token is rewritten
  to the resolved dir so a stale install falls back to the seed) PLUS one
  representative action classified by capability kind (`classifyAction`, `:99`):
  - runtime → a delegate round-trip through its bridge (agent-sdk/opencode over free
    ollama; codex ONE budgeted real delegate, cache-gated to a single call, `--probe`
    elsewhere; gemini `--probe` = documented unauthed degradation; claude-code-runtime
    is primary-only, `probe` health);
  - gateway → the column's own boot IS the action;
  - connector → catalog parse of the manifest's `connector.actions` (no external calls);
  - memory-store → a real read via `basic-memory project list`;
  - channel/own-port/view → HTTP health/status if the server is up, else `verify-only`;
  - everything else → manifest parse + verify.
  Every cell is captured as `{status: pass|degraded|fail|verify-only, note}`; a single
  fitting's failure never aborts the run.
- **Rendering (`renderMatrix`, `:492`).** Emits the run header + environment, the
  primary boot table, the Fitting × primary matrix, per-primary counts, the full
  "Degradations observed" table (every non-pass cell + cause), a standing
  interpretation block, and the zero-fail verdict.

Pure-layer unit test committed at `tests/matrix-harness.test.ts` (9 tests:
`classifyAction` priority order for all kinds; `renderMatrix` sections + the
fail-flips-verdict path).

## Degradations recorded (feed S2d)

- **`gemini-runtime` (all 3 columns) — unauthed on this box.** CLI present
  (`--probe` ok); no Gemini creds, so a real authenticated delegate turn can't run.
  Expected; not a code defect.
- **`opencode-runtime` delegate (opencode + claude-code columns) —
  small-local-model under concurrent load.** On the free ollama `qwen2.5:3b`, when
  the primary turn + agent-sdk + opencode delegates fire back-to-back at the single
  ollama, the small model intermittently emits only lifecycle events with no `text`
  part and the adapter correctly fails loud (I3 — never fabricates output). It
  **passes isolated and in the `codex` column** (no ollama contention) — verified by
  a direct re-run that returned a real summary. Small-model quality under
  concurrency, not an adapter/transport bug.
- **`verify-only` own-port fittings — the harness does not `up` the composition.**
  Their HTTP servers only start under a real `up`; the verify hook is the health
  signal. Where Garrison was live, `dev-env`, `orchestrator`, `web-channel-default`,
  and `power-default` returned real HTTP 200.
- **Budget conservation `verify-only` cells.** `claude-code-runtime` is primary-only
  (no delegate bridge; served live as the primary). `codex-runtime`'s delegate is
  gated to ONE real call (spent in the codex column); read-only `--probe` elsewhere.

Total live model turns spent: 3 primary served turns (opencode/ollama free, codex 1,
claude-code 1 haiku) + 1 codex delegate + several free ollama delegates. Within the
budget the brief set (ONE codex primary + ONE codex delegate; ONE claude served turn).

## Wall

- `npm run typecheck` — 0 errors.
- `npx next lint` on the three touched files — clean.
- `npm test` (full) — **239 files passed | 6 skipped; 2068 tests passed | 14 skipped; 0 failed.**

## Commits

- `0f783ee` — fix(gateway): opencode as a first-class primary engine (S2c agnosticism)
- `feat(matrix): runtime-agnosticism matrix harness (S2c)` — harness + harness unit test
- `docs(matrix): full Fitting × primary matrix run (S2c)` — RUNTIME_MATRIX.md,
  matrix-cells.json, this impl.md
