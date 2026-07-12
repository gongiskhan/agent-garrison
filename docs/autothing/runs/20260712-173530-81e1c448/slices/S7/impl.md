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
