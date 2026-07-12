# S2b — opencode-runtime Fitting (impl)

Run: `20260712-173530-81e1c448`
Slice: S2b (OpenCode as a first-class Garrison runtime)
Date: 2026-07-12
Author: opencode-runtime implementer agent

## Outcome

OpenCode (CLI v1.17.15) is now a first-class Garrison runtime Fitting under the
`runtimes` faculty, providing `{kind: runtime, name: opencode}`, wired into the
default composition, registered in the library, and covered by committed vitest
tests. Wall is green.

> **Takeover note.** Partway through, the run issued an "S2b stall takeover"
> (`c1e5bdb`) and the impl files were committed by the takeover as WIP in a
> **run-subprocess-primary** design (not the serve-primary design the brief
> described): `7f0acbb` manifest, `01de47b` adapter, `0b80063` bridge, `7a7ff35`
> registry+composition. I independently reached a compatible implementation,
> then realigned my bridge + tests to the committed run-subprocess design and
> contributed the committed test suite (the takeover WIP shipped no tests) plus
> the runtime-peer test enumerations.

## Files

Impl (committed by the takeover WIP, verified against the live CLI + full suite):
- `fittings/seed/opencode-runtime/apm.yml` — `provides {kind: runtime, name: opencode}`, faculty `runtimes`, `cardinality_hint: multi`, `component_shape: cli-skill`; `provider_mechanism` config-file `~/.config/opencode/opencode.json` (json, `config_key: provider`, `model_key: model`); `quarters_descriptor` tier `generic` id `opencode` (home `~/.config/opencode`, context `AGENTS.md`, mcp key `mcp`, log `~/.local/share/opencode/log`); `verify` = `bridge.mjs --probe` expect `ok`; default model `ollama-local/qwen2.5:3b`.
- `fittings/seed/opencode-runtime/lib/opencode-adapter.mjs` — `OpenCodeAdapter` (RuntimeAdapter), `buildRunArgs`, `parseRunOutput`.
- `fittings/seed/opencode-runtime/scripts/bridge.mjs` — `--probe` + `delegate` (task spec via STDIN), no serialization lock.
- `data/library.json` — `opencode-runtime` entry (localPath, platforms).
- `compositions/default/apm.yml` — dependency path + `selections.runtimes` id `opencode-runtime`.

Tests (my commits `a0953a9`, `cf37679`):
- `tests/opencode-runtime.test.ts` — the committed test suite (12 tests).
- `tests/faculties.test.ts` — added `opencode-runtime` to the runtimes-faculty enumeration.
- `tests/claude-code-runtime.test.ts` — added `opencode-runtime` to the library runtime-peer set.

## Adapter transport design (as committed)

Run-subprocess-primary, stateless — the sibling shape of codex/gemini, not a
standing server:

- **spawn/turn**: each turn is one `opencode run --format json --auto` subprocess.
  Model via `-m provider/model`; reasoning effort via `--variant`; cwd via `--dir`;
  resume via `-s <sessionId>`. The prompt travels on **STDIN, never argv**
  (injection-safe under bypassPermissions).
- **awaitResponse** parses the NDJSON event stream (`parseRunOutput`): assistant
  text = concatenation of `{type:"text", part:{text}}` events; session id = the
  top-level `sessionID` on every event (captured so the next turn resumes with
  `-s`); a terminal `{type:"error"}` is surfaced, and a code-0 run that produced
  no text but did error **throws loudly** rather than returning empty.
- **no standing server, no scoped config, no lock** — OpenCode has no shared-token
  revocation issue (unlike Codex), so concurrent processes are safe and no
  machine-wide mutex is needed.
- **provider/model**: resolved from OpenCode's native `~/.config/opencode/opencode.json`
  (`model` = `provider/model`); default `ollama-local/qwen2.5:3b` so delegation is
  bill-free once the local provider is configured there (documented in `for_consumers`).
  Model allowlist `^[a-z0-9][a-z0-9._-]*/.+` (provider/model form; rejects bare names).

## Flag / endpoint findings vs the research (E15) — verified live against v1.17.15

1. **`opencode run` reads the prompt from STDIN.** The research/CLI help showed
   `run [message..]` as a positional; verified live that with **no positional and a
   piped prompt**, opencode creates a session and processes it, while **empty stdin
   + no positional** errors `"You must provide a message or a command"`. So stdin is
   a real message source — the committed adapter uses it (the manifest's "prompt via
   stdin" claim holds).
2. **Design pivot: run-subprocess vs serve.** The research recommended (and the
   brief specified) a serve-primary design (`opencode serve` + HTTP API). The
   takeover chose the run-subprocess form — the research's own "apples-to-apples
   analog of `codex exec`" — which matches codex/gemini exactly and needs no server
   lifecycle. Both were verified viable (I booted a real `opencode serve` and
   round-tripped `POST /session`, `/global/health`, basic auth). The serve path is
   not shipped.
3. **v2 prompt body cannot carry per-call model/variant** (verified against the live
   `GET /doc` OpenAPI): `PromptInput = {text, files, agents}` only; per-call
   `model`/`variant`/`agent`/`system`/`tools` live only on the legacy send-and-await
   `POST /session/{id}/message`. This made a v2-primary serve path awkward and was a
   factor in the run-subprocess pivot (which passes `-m`/`--variant` per invocation).
   Path param is `{sessionID}` (not `{id}`); `wait` returns `204`.
4. **Config resolution**: both `OPENCODE_CONFIG=<file>` and `XDG_CONFIG_HOME` select
   an alternate config (verified: `opencode models` listed the injected ollama model).
   Native config file `~/.config/opencode/opencode.json[c]` (schema
   `https://opencode.ai/config.json`); confirmed keys `provider`, `mcp`, `permission`,
   `model`, `instructions`. Data/log dir `~/.local/share/opencode/log`.
5. **Server auth** (serve path only): `opencode serve` honors `OPENCODE_SERVER_PASSWORD`
   (HTTP basic auth) — verified `401` without creds, healthy with creds; default port
   4096, host 127.0.0.1.

## Tests (12, committed)

`tests/opencode-runtime.test.ts`:
- buildRunArgs: `run --format json --auto`, `-m`, `--variant`, `--dir`, `-s`, prompt via STDIN never argv
- exposes every RuntimeAdapter method + a string id (ADAPTER_METHODS loop)
- parseRunOutput: text from text events, sessionId from top-level `sessionID`, terminal error surfaced
- passes the RuntimeAdapter conformance harness (stub exec)
- feeds the prompt via stdin (never argv) and captures the minted session id
- setEffort maps to `--variant`, resume replays a prior session id via `-s`
- a code-0 run that only errored (no text) fails loudly
- bridge delegate: validates spec, schema-valid `{summary, artifacts}`, writes output, logs `runtime: opencode`
- primary integrates the OpenCode summary (secondary-delegate-ok)
- rejects a model outside the provider/model allowlist (loud)
- seed manifest parses (faculty runtimes, provides runtime:opencode, config-file mechanism, generic quarters descriptor)

Enumeration guards: `faculties.test.ts` (opencode-runtime → runtimes), `claude-code-runtime.test.ts` (opencode-runtime in the library peer set).

## Wall

- `npm run typecheck` — 0 errors.
- `npm run lint` (`next lint`) — clean.
- `npx tsx scripts/validate-fitting.ts fittings/seed/opencode-runtime` — PASS (architecture / security / prompt-injection / quality).
- `node fittings/seed/opencode-runtime/scripts/bridge.mjs --probe` — prints `ok`.
- `npm test` — **236 files passed / 6 skipped; 2021 tests passed / 14 skipped; 0 failed** (clean run). One earlier run flaked with 2 failures in unrelated `http-gateway` soul-spawn / `improver` ECONNREFUSED spawn tests (concurrent-agent load); did not reproduce and is untouched by S2b.

No live model turn was run (no opencode credentials; ollama not confirmed up). The
live delegate round-trip is a later gate, not this slice — the tests mock the run
transport (injected `runExec`), so they need neither a live opencode server nor ollama.

## Commits

- `a0953a9` — test(opencode-runtime): committed run-adapter + delegate-bridge + seed-manifest tests, runtime-peer enumeration (S2b)
- `cf37679` — test(opencode-runtime): explicit RuntimeAdapter method-contract check
- `040133c` - feat(opencode-runtime): opencode as a first-class runtime Fitting (S2b) - feature capstone (`seedIds` addition), and the `--probe` version-string assertion + stateless-first manifest/library summaries applied by the takeover (impl-s2b-2).

Impl files landed earlier via the takeover WIP: `7f0acbb`, `01de47b`, `0b80063`, `7a7ff35`.
