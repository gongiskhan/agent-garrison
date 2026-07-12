# S2a1 + S2a2 — fresh-context adversarial review

**Verdict: APPROVE**

Reviewer: fresh-context (no implementer notes). Range reviewed:
`git diff 9f44143~1..a968d5e` (commits 9f44143 feat + a968d5e test).
Files: `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs`,
`packages/claude-pty/src/multi-runtime-pool.mjs`,
`tests/gateway-runtime-adapter-routing.test.ts`,
`tests/agent-sdk-primary-smoke.integration.test.ts`.

## Evidence I ran myself

- `npm run typecheck` → **exit 0**.
- `npm test` (FULL suite) → **235 files passed / 6 skipped; 2007 tests passed | 14 skipped (2021)**, exit 0. Matches the "~2007-test suite green" acceptance (claude-code primary behavior unchanged).
- `npx vitest run tests/gateway-runtime-adapter-routing.test.ts` → **6 passed**.
- Gated live smoke `GARRISON_INTEGRATION=1 GARRISON_OLLAMA_MODEL=qwen2.5:3b npx vitest run tests/agent-sdk-primary-smoke.integration.test.ts` → **1 passed (38.8s)**. Real evidence emitted:
  - classifier-fallback: `{"from":"claude-code","to":"agent-sdk","reason":"claude-code runtime not resolvable (CLI absent)..."}`
  - ollama real turn reply: `"pong"`
  - adapter-moves log: `{"path":"adapter-moves","injections":["/model qwen2.5:1.5b","/effort high"],"runtime":"agent-sdk"}`

## Acceptance criteria — all met

1. **Stage-B moves via adapter** — `applySwitch` (gateway-routing.mjs:656-684): inside the `writeKeys !== "function"` guard, when the adapter implements both `setModel`+`setEffort` it applies exactly the moves `planSwitch` planned and records `adapter-moves`; the old `route-switch-skipped` fires ONLY when the adapter lacks the methods. Covered by both the WITH-methods and WITHOUT-methods unit tests. ✅
2. **Resume via adapter** — `respawnOperative` (703-761): a non-claude adapter (`adapter.id !== "claude-code" && typeof adapter.resume === "function"`) resumes through `adapter.resume`; the claude path is byte-identical (spawnFn + `--continue`, logged `spawn-continue`). Both regression tests pass. ✅
3. **Classifier stays claude-code haiku** — `resolveClassifierAdapter` (990-1015): claude-code primary → primary adapter; non-claude primary + claude-code resolvable → fresh `ClaudeCodeAdapter` haiku (no fallback log); non-claude + claude-code absent → primary adapter + loud `classifier-fallback` log. Both tests + live smoke confirm. ✅
4. **Committed gated live smoke** — present, gated on `GARRISON_INTEGRATION=1`, and I ran it green (see above). ✅
5. **resolvePrimaryAdapter honors provider/promptMode** — (901-925): `operativeSpawnConfig.provider ?? "anthropic"`, `promptMode ?? "full"`; optional baseUrl/leanPrompt/secrets are spread ONLY when truthy, so the emitted object is byte-identical (same keys, same order) when unset. ✅
6. **claude-code primary unchanged** — 2007-test suite green + typecheck clean. ✅

## The four probed failure modes

- **(a) Partial move (setModel ok, setEffort throws → currentTarget stale):** *Possible in the abstract but non-blocking.* The loop has no per-move try/catch and `this.currentTarget = route.target` is set AFTER the loop, so a mid-loop throw would leave the adapter moved on model while `currentTarget` still reflects the old target. BUT: (i) this is exact parity with the pre-existing `writeKeys` path (686-690), which is equally non-atomic — not a regression; (ii) the real `AgentSdkAdapter.setModel/setEffort` (agent-sdk-adapter.mjs:148-158) are pure local field assignments that cannot throw; (iii) it self-heals next turn since `planSwitch` recomputes from `currentTarget`. Observation only.
- **(b) resume teardown ordering leaks old session on failure:** *No.* Ordering is resume-FIRST → teardown-old (try/catch, ignored) → swap. On `adapter.resume` failure the old session is retained and no swap happens (no leak). On teardown failure the swap still proceeds (best-effort). Correct ordering.
- **(c) classifier fallback misfires when claude-code IS resolvable but primary non-claude:** *No.* `resolveClassifierAdapter` checks `claudeCodeResolvable` BEFORE the fallback branch and returns a `ClaudeCodeAdapter` with no fallback log; the "resolvable → STAYS on claude-code" unit test asserts exactly this.
- **(d) a non-writeKeys session reaching writeKeys:** *Impossible.* The `adapter-moves` branch and the skip branch are both INSIDE `if (typeof this.operative?.session?.writeKeys !== "function")`; the `writeKeys` inject loop is in the ELSE. A non-PTY session can never reach `writeKeys`.

## Non-blocking observations (context, not rework)

- **Reachability of adapter-moves via preRoute:** In the real `preRoute` flow (627-633) an `agent-sdk` target is routed to the separate `"agent-sdk"` plan path and `applySwitch` is skipped, so the adapter-moves path is reached only when an agent-sdk-primary operative resolves to a NON-agent-sdk target (e.g. a claude-code/anthropic model), in which case `setModel` would push an Anthropic model name onto e.g. an ollama session. That is a routing-config coherence question (target resolution for a non-claude primary — later/S2b scope), not a defect in the S2a mechanism. The smoke test correctly calls `applySwitch` directly with a coherent agent-sdk target.
- Empty-injections slash-inject (both model+effort unchanged) yields `moved=[]` and just sets `currentTarget` — harmless.

No material or blocking findings. Ship it.
