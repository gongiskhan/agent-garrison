# S2b fresh-context adversarial review — opencode-runtime

**Verdict: APPROVE**

Reviewer: fresh-context adversarial (no access to implementer notes). Scope: the
opencode-runtime commits `7f0acbb, 01de47b, 0b80063, 7a7ff35, a0953a9, cf37679,
040133c` within `cefa66c..040133c`. All evidence gathered independently.

## Acceptance criteria — all met

1. **Complete runtime Fitting** (`fittings/seed/opencode-runtime/apm.yml`) — PASS.
   `provides: [{kind: runtime, name: opencode}]`, `consumes: []`. Real verify hook
   `node apm_modules/_local/opencode-runtime/scripts/bridge.mjs --probe` (expect `ok`,
   matches the codex/gemini path convention exactly). `provider_mechanism` is
   config-file over `~/.config/opencode/opencode.json` (`config_key: provider`,
   `model_key: model`). `quarters_descriptor` is `tier: generic`, id `opencode`,
   context_file `AGENTS.md`, mcp/log/settings surfaces. Manifest parses (seed-manifest
   test asserts every field).

2. **Adapter implements every RuntimeAdapter method** (`lib/opencode-adapter.mjs`) — PASS.
   `id` + all 8 `ADAPTER_METHODS` (spawn, awaitReady, sendTurn, awaitResponse,
   setModel, setEffort, resume, teardown) present and exercised by the conformance
   harness. Stateless `opencode run --format json --auto` transport; prompt travels via
   **stdin** (`child.stdin.end(stdin)`), model via `-m` **argv array element** (never
   shell-interpolated), session continuity via `-s <sessionId>` with the minted id
   captured in `awaitResponse` (line 106). **Every flag verified against the real CLI**
   (`opencode run --help`, opencode 1.17.15): `-m/--model` provider/model, `--format json`,
   `-s/--session`, `--variant`, `--dir`, `--auto`, optional positional message → stdin.
   The stubbed tests could have hidden a wrong flag name; they don't.

3. **Bridge matches the codex contract** (`scripts/bridge.mjs`) — PASS. stdin (or
   `--spec-file`) task-spec → `{summary, artifacts}` via the shared
   `delegate()`/`parseTaskSpec()`; `--probe` health check. The probe is *more* robust
   than codex's (asserts a version string, not just exit 0). Correctly omits the
   machine-wide serialization lock (documented: opencode has no shared-token
   revocation, unlike codex's OAuth).

4. **Wired** — PASS. `data/library.json` entry; `compositions/default/apm.yml`
   dependency (`../../fittings/seed/opencode-runtime`) **and** `selections.runtimes`
   entry (`- id: opencode-runtime`).

5. **Tests non-vacuous** — PASS. `tests/opencode-runtime.test.ts` injects a fake
   `runExec` (no real network/opencode). Covers: buildRunArgs flag shape + prompt-not-in-argv,
   method contract, NDJSON parse (text/sessionID/terminal-error/empty), conformance
   harness, stdin-not-argv + session capture, setEffort→--variant + resume→-s,
   code-0-but-errored fails loudly, bridge delegate {summary,artifacts}+log, allowlist
   reject, missing-task reject, seed manifest. `tests/seed.test.ts` gained the id;
   sibling `claude-code-runtime`/`faculties` tests **strengthened** (opencode added to
   the peer/runtimes enumerations). Full suite: **2021 passed, 14 skipped, 0 failures**.

6. **No other fitting's behavior changed** — PASS. The opencode commits touch only
   `fittings/seed/opencode-runtime/**`, the two wiring files, and test enumerations.
   (The `warm-pool.mjs`/`gateway-routing.mjs` edits in the range are commit `e2113e8`,
   S2a — out of this review's scope.)

## Adversarial checks

- **Shell injection** — CLEAN. `spawn(bin, argv, …)` / `spawnSync(cmd, [args], …)`
  throughout; no `shell:true`, no `execSync`, no template interpolation into a command.
  Prompt via stdin; model/variant/dir are argv elements. Model is also validated by
  `MODEL_ALLOWLIST` in `delegate()` before spawn.
- **JSON parse** — GUARDED. `parseRunOutput` wraps `JSON.parse` in try/catch and
  `continue`s on non-JSON lines; `parseTaskSpec` throws a loud `DelegationError` on bad
  JSON; the bridge catches and emits a structured error.
- **Session-id capture** — CORRECT at the adapter level (first `sessionID`, persisted to
  `session.sessionId`, replayed via `-s` on the next `sendTurn`).
- **Teardown leaks** — NONE. Stateless; the child resolves on `close`/`error`; no
  standing process; WeakMap entry GC'd with the session.
- **Artifact path traversal** — NONE. `writeArtifact` is called with a hardcoded
  namespace `delegations` and a timestamp-derived name (`opencode-<iso>.md`, colons/dots
  replaced) — neither is task_spec-controlled; `resp.artifacts` is always `[]`.
- **`--auto` outside cwd** — informational/by-design. `--auto` is "auto-approve
  permissions … (dangerous!)" per the real CLI; opencode is not OS-confined to `--dir`.
  This matches the bypassPermissions posture of the codex/claude siblings and the
  single-user local threat model; `--dir` comes from orchestrator-controlled `spec.cwd`,
  not external input.

## Non-blocking observations (no fix required for approval)

- **No subprocess timeout** in `defaultRunExec` (opencode-adapter.mjs:58–70): a hung
  `opencode run` would block `awaitResponse`/the bridge indefinitely (Claude's adapter
  uses a 120s `runTurn` timeout). This is **identical to the accepted codex-adapter**
  (parity, not an S2b regression); with `--auto` on a local model a runaway loop is
  plausible, so a future hardening pass across both non-PTY adapters is worth a note.
- **`-s` resume across `delegate()` calls is not end-to-end**: the adapter captures the
  minted session id, but `delegate()` returns only `{summary, artifacts}`, so a fresh
  bridge process can't obtain the prior id. The `-s` continuity is real at the
  adapter/pool level (long-lived session object) and acceptance #2 is satisfied; the
  `for_consumers` "follow-up turns resume it" phrasing slightly over-reads the one-shot
  bridge path. Matches the codex bridge.

## Evidence run by the reviewer

- `npm run typecheck` → clean (tsc --noEmit, no output).
- `npm test` (full) → **236 files passed / 6 skipped; 2021 tests passed / 14 skipped; 0 failures**.
- `npx tsx scripts/validate-fitting.ts fittings/seed/opencode-runtime` → **Overall PASS**
  (architecture / security / prompt-injection / quality all PASS).
- `node fittings/seed/opencode-runtime/scripts/bridge.mjs --probe` → `ok` (exit 0);
  `opencode --version` → `1.17.15` (matches the manifest's claimed version).
- `opencode run --help` → confirmed every flag the adapter emits is a real, correctly-used flag.
- `git show --stat` on each of the 7 opencode commits → confirmed no other fitting touched.
