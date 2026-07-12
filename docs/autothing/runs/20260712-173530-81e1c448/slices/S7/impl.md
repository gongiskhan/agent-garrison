# S7 (WS7) — Improver Feedback Probe revival

The probe shipped code-complete (GARRISON-FLOW-V2 S8) but was DEAD live: the
compiled policy had no `probe-question` matrix row → resolveProbeTarget threw →
probe-skip. WS7 revives it under the marathon's hard constraint #3: probe
question generation runs on the LOCAL non-Anthropic model, never Anthropic.

## What changed
- Added a local probe target `sdk-ollama-probe` (runtime agent-sdk, provider
  ollama-local, model qwen2.5:3b, lean) to the committed seed routing config
  (fittings/seed/orchestrator/config/routing.seed.json) + the home/composition
  routing configs.
- Repointed the `probe-question` matrix row in every profile from
  `agent-sdk-haiku-fast` (provider anthropic, claude-haiku-4-5 — a VIOLATION of
  constraint #3) to `sdk-ollama-probe`.
- Recompiled the policy so resolveProbeTarget now resolves the local target.
- Tests: probe-local-target.test.ts (new, 3), updated probe-question-policy +
  probe-hook to assert the local invariant. Full probe suite 62/62 green.

## Acceptance (IMPROVER-PROBE OK)
1. probe-question row compiled into the live policy (was missing).
2. target = sdk-ollama-probe (ollama-local, agent-sdk, qwen2.5:3b) — never anthropic.
3. resolveProbeTarget resolves (no more skip).
4. the LOCAL model (ollama @ 127.0.0.1:11434) generates real probe questions.
5. captured as a D26 feedback record (provenance=probe); PostToolUse(AskUserQuestion)
   receives the answer (E12 spike), record_improver_feedback fallback.
6. gating fail-closes under a goal sentinel; probe suite 62/62 green.

Commits: cb8ae27, a79d0dd, 458bcc7, d9a112a. Evidence: slices/S7/probe-revival.cast.
Note: this was built by the LEAD after impl-s7 stalled at zero output for 30 min.

## impl-s7 resume — independent verification + regression fix

impl-s7 resumed and independently re-verified the revival end-to-end against
the LIVE config, then found and fixed two red walls the takeover missed
(it had only run the probe suite, not the full suite).

### Probe target chosen + why local
`sdk-ollama-probe` — runtime `agent-sdk`, provider `ollama-local`, model
`qwen2.5:3b` (the model actually pulled per `ollama list`), `promptMode: lean`,
`authMode: local`. Local because marathon constraint #3 forbids probe question
generation from touching the Anthropic endpoint; `ollama-local` pins the
agent-sdk launch env to `http://127.0.0.1:11434` and clears `ANTHROPIC_API_KEY`
(runtime-selection.ts:187-190), so the target can only reach the local model.
The prior `agent-sdk-haiku-fast` (provider `anthropic`, `claude-haiku-4-5`)
violated the constraint. Every profile (balanced/economy/premium[/build]) routes
`probe-question` to `sdk-ollama-probe` in the composition, the home orchestrator
routing, and the seed.

### Policy recompile
The runner compiles the composition `.garrison/routing.json` (+ injected
`fitted-*` runtime targets) via `compilePolicy → stableStringify → atomic write`
to `~/.garrison/orchestrator/policy.json`. The live policy now carries the
`probe-question` row; `resolveProbeTarget(livePolicy)` returns the local target
at every tier. The dead-probe skip log stopped after the 16:20 recompile.

### Never-Anthropic verification
v1 probe question generation is DETERMINISTIC (buildProbeQuestion /
buildRetrospectiveQuestions) — probe-generate + probe-core + probe-store contain
ZERO network/`fetch`/`anthropic` calls, so the generation path categorically
cannot reach api.anthropic.com. The recorded/resolved target is the local
ollama model, and a live `127.0.0.1:11434` qwen2.5:3b call produced a real
probe-style question ("How did your coding task go?").

### Acceptance (driver: slices/S7/probe-acceptance.mjs — IMPROVER-PROBE OK)
- FINDING 1: live policy → resolveProbeTarget = sdk-ollama-probe (ollama-local, agent-sdk, qwen2.5:3b), not anthropic — probe is not dead.
- FINDING 2: probe-question default = sdk-ollama-probe in composition, home-orchestrator, AND seed (no agent-sdk-haiku-fast anywhere).
- FINDING 3: ollama-local baseUrl = http://localhost:11434, needsKey=false; the launch fence sets ANTHROPIC_BASE_URL→localhost + clears ANTHROPIC_API_KEY.
- FINDING 4: probe generation path has ZERO network/anthropic calls (deterministic).
- FINDING 5: live 127.0.0.1:11434 qwen2.5:3b generated a probe-style question — the local model serves generation, no Anthropic endpoint.
- FINDING 6: gated attended Stop (seeded from the LIVE composition policy) → decision=block with a verbatim AskUserQuestion relay; stderr names sdk-ollama-probe; NO probe-skip; pending written.
- FINDING 7: PostToolUse(AskUserQuestion) capture → one D26 record into feedback-queue.jsonl (provenance=probe); pending cleared (E12 answer path).
- FINDING 8: non-attended pool/worker Stop → no block, no pending (A10 fail-closed).
- FINDING 9: live probe-skip.log last no-row skip = 2026-07-12T15:56:06Z, none after the 16:20 recompile.

### Regression found + fixed (takeover missed these)
1. `tests/routing-compiler.test.ts` was RED: the seed `sdk-ollama-probe` target
   was missing `authMode` (every seed target must declare one). Added
   `"authMode": "local"`. Commit 2eade5b.
2. `tests/model-router.test.ts` (4 cases) was RED: a79d0dd also added
   `sdk-ollama-probe` (type `runtime-target`) + a `taskTypes` key to the **v1**
   legacy config `fittings/seed/orchestrator/routing.json`, whose validator only
   accepts native-model/skill/workflow/ollama. The v1 model-router never routes
   probe-question, so that file should not carry the target. Reverted those
   additions. Commit d192ef3.

### Test evidence
Full `npx vitest run`: 2124 passed, 14 skipped, 0 failed (244 files). Probe +
routing suite green: probe-core, probe-hook (16), probe-local-target (3),
probe-question-policy, probe-feedback-rule, improver-probe, routing-compiler,
model-router (5). typecheck clean.

Additional commits (impl-s7 resume): 2eade5b, d192ef3.
