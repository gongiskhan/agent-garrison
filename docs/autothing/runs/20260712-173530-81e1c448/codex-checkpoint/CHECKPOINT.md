# Run-level codex checkpoint — GARRISON-MARATHON-V1

Two decorrelated cross-model passes (`codex exec`, gpt-5.5, reasoning high,
isolated `CODEX_HOME` with auth only + no MCP, `--sandbox danger-full-access`,
serialized). Every finding was adversarially verified against the real code
before disposition — codex over-reports, so a HIGH label alone is not a verdict.

## Pass A — file/clone/composition/index containment (10 findings raw → 4 fixed, 5 accepted)

| # | Finding | Verified | Disposition |
|---|---------|----------|-------------|
| A1 | `fitting-files.readFile` follows a Fitting-carried symlink (`leak.md -> /etc/passwd`) off-root | REAL — read path lacked the write path's `assertNoSymlinkEscape` | **FIXED** (09d3a07) + test |
| A2 | `fitting-files.listDirectory` follows a symlinked dir (`out -> /etc`) off-root | REAL — same root cause | **FIXED** (09d3a07) + test |
| A3 | `createFile` TOCTOU: two concurrent creates both pass the existence check | REAL but single-user local tool; no realistic concurrent identical-path create | **ACCEPTED** (out of threat model) |
| A4 | `clone.ts` `dereference:true` copies an escaping symlink's target bytes into the clone | REAL — a malicious local Fitting could exfil host bytes into a readable clone file | **FIXED** (09d3a07): reject escaping symlinks pre-copy; internal-symlink deref test stays green |
| A5 | `clone.ts` concurrent same-id clone: loser's `rm(destAbs)` deletes the winner's dir | REAL but requires two concurrent clones with the SAME explicit id; library append already serializes | **ACCEPTED** (out of realistic single-user usage) |
| A6 | `active-composition` classifies a symlinked `compositions/evil` as internal (lexical `path.relative`) | REAL but the pointer source is user-trusted (localhost switch / CLI); local access ⇒ full access anyway | **ACCEPTED** (trusted input) |
| A7 | `composition-switch` concurrent switch race (both down, both up) | REAL but single-user; no concurrent switches in practice | **ACCEPTED** (out of usage model) |
| A8 | `index-store.walkMarkdown` follows the ROOT `docs` arg when it is itself a symlink | REAL — the per-entry `isRealPath` guarded children, not the root arg | **FIXED** (09d3a07) + test |
| A9 | `index-store` unbounded `readFileSync` on a huge own-repo doc | REAL but self-DoS on the user's own content; bodies are sliced to 1200 chars downstream | **ACCEPTED** (low severity, own content) |

## Pass B — runtime agnosticism + non-Anthropic probe fence (1 finding raw → 1 fixed)

| # | Finding | Verified | Disposition |
|---|---------|----------|-------------|
| B1 | agent-sdk-as-primary on a non-Anthropic provider defaults its spawn config provider to `"anthropic"` because `gateway-pty.mjs` never threads `GARRISON_PROVIDER` into `operativeSpawnConfig` | REAL wiring gap — **but codex overstated it as an Anthropic-endpoint leak.** Verified: for a non-Anthropic primary, `buildPrimaryRuntimeEnv` sets `ANTHROPIC_BASE_URL=localhost` in the gateway PROCESS env with `providerLaunch`, and the SDK inherits process.env underneath, so the endpoint was still localhost. The real defect was the wrong capability profile + a fence that leaned on inheritance. The routed/probe path (`route.target.provider`) was already correct and is separately verified fenced (final-gate FINDING 3). | **FIXED** (this pass): thread the provider explicitly (`anthropic-plan`→`anthropic` spec key). Byte-identical anthropic default preserved. Regression test both directions. |

Pass B explicitly cleared: unknown primary engine throws; OpenCode empty/malformed
output throws (no silent success); probe-question policy cells resolve to the
local target. "The other checked areas did not produce a concrete surviving
crash/leak."

## Net
5 real defects fixed with regression tests (4 containment + 1 runtime-wiring); 5
lower-severity findings accepted with reasons recorded (all concurrency /
trusted-input / self-DoS, outside the single-user localhost threat model). No
Anthropic-endpoint leak exists on any path — the hard "probe never hits Anthropic"
constraint holds (final-gate FINDING 3 + probe-acceptance FINDINGs 3-4).

The WS2c matrix exercised claude-code/codex/opencode primaries; **agent-sdk as a
primary with a non-Anthropic provider was not in the matrix**, which is why B1
survived to the checkpoint. Recorded as a matrix-coverage gap.

Raw pass output: `passA-output.txt`, `passB-output.txt`. Prompts:
`passA-prompt.txt`, `passB-prompt.txt`.
