# T1 Sub-Agent Spike Report

**Phase 4, Ticket T1.** Throwaway. Delete this directory after T2 ships
(or fold the relevant variant's pattern into the coding-subagent
Fitting and remove the rest).

**SDK version probed:** `@anthropic-ai/claude-agent-sdk@0.2.132` from
`compositions/default/apm_modules/_local/http-gateway/node_modules/`.
**Claude CLI probed:** `/Users/ggomes/.local/bin/claude`.

## Outcome

**Recommendation: Variant A (CLI-shape skill).** All three variants
work; Variant A is the closest fit to the existing seed Fitting
pattern and is what T2 builds on. Variant B is the documented
fallback. Variant C is a strong v1.1 contender for lower latency
but adds gateway-internal complexity we don't need yet.

## Variant matrix

| | A — CLI-shape | B — External `claude` | C — Gateway-internal |
|---|---|---|---|
| File edit landed | yes | yes | yes |
| Tool set available | full (Glob/Read/Edit) | full | full |
| Wall time | ~16.3 s | ~12.7 s | ~30 s (3 turns) |
| First chunk latency | 15.6 s | 4.2 s | n/a (final-text path) |
| Parent context isolation | n/a (separate process) | n/a (separate process) | **preserved** |
| Cancellation primitive | SIGTERM child | SIGTERM child | `Query.interrupt()` |
| Stdout from child | stream-able as JSON lines | stream-able with `--output-format stream-json` | n/a (in-process events) |
| Cost per spike run | ~$0.10 (sonnet) | not measured | ~$0.30 (sonnet, 3 turns) |

## Three evaluation questions, answered

### 1. Tool support — can the sub-agent use the full Claude Code tool set?

**Yes, for all three variants.** The SDK's `query()` and the `claude
--print` CLI both expose Read/Edit/Bash/Glob without special opt-in
when `permissionMode: "bypassPermissions"` is passed. No tools were
gated; the sub-agent successfully invoked Glob → Read → Edit for the
README append in both Variant A and Variant C.

### 2. Context isolation — does sub-agent chatter pollute the parent?

**Variant C explicitly tested this and isolation held.** The parent
session was opened with system prompt *"You are Quill, a
poetry-loving conversational assistant"*. A sub-agent ran in the
same Node process with system prompt *"You are a coding sub-agent"*.
On resume of the parent session, the parent's reply to "who are
you?" was *"I am Quill, a poetry-loving assistant."* — exact match,
no coding-flavored leakage.

For Variants A and B the question is moot — they run in separate
OS processes from the gateway, so no shared in-memory state
exists.

**Implication:** in-process sub-agent spawning is *safe* (Variant C
viable), but separate-process spawning (A) is *trivially safe* and
removes a class of "did I correctly route options.systemPrompt to
the right `query()` call?" footguns.

### 3. Streaming output — real-time vs final result?

- **Variant A:** the SDK yields incremental events from the
  `for await` loop. The script can flush each `assistant`
  text chunk and `tool_use` event to stdout as it happens.
  Latency to first chunk in this run: 15.6 s (after the model
  finished thinking — Claude's tool-use phase doesn't emit text
  chunks). For T4 (Run-tab log stream), the relevant signal is
  the `tool_use` events emitted along the way, which arrive in
  real time.
- **Variant B:** with `--output-format stream-json`, the
  `claude` CLI prints one JSON object per event as it occurs.
  First stdout at 4.2 s, total 12.7 s. Same shape as A.
- **Variant C:** events are in-process. The gateway can call
  `onEvent` callbacks immediately. Latency-bound only by the
  model.

**Implication for T4:** all variants stream tool-use events
incrementally. The Run-tab pane gets per-tool status updates
without polling.

## Bonus finding — interrupt support

`Query.interrupt(): Promise<void>` exists in the SDK type
definitions. This is the cancellation primitive for any
in-process sub-agent (Variant C). For Variants A and B,
cancellation is just `child.kill('SIGTERM')` followed by a
process-tree termination if the SDK's child processes
(MCP servers etc.) don't exit cleanly.

**T6 implication:** the kill mechanism for the chosen Variant A
implementation is `process.kill(-pid)` of the sub-agent's process
group. Test in T6 that no zombie MCP server processes are left
behind.

## Why Variant A wins for T2

1. **Fitting consistency.** Every existing skill in the
   composition (`tier-classifier`, `documents`,
   `projects-index`, `garrison-memory`) is invoked by the
   Operative as a CLI command via the Bash tool. Variant A
   matches this pattern exactly. Variant C would require a
   new "tool registered with the gateway" mechanism that
   doesn't exist today.
2. **Process isolation cuts blast radius.** A buggy sub-agent
   can't crash the gateway. The conversational session
   survives anything the sub-agent does.
3. **Killing is OS-native.** No "is the SDK's interrupt
   semantics what I think?" footgun. SIGTERM the child
   process; the OS reaps it.
4. **Logging is naturally separable.** The sub-agent's stdout
   is its own stream. T4's second log pane reads
   `compositions/<id>/logs/coding-subagent-<execution-id>.log`
   which the CLI writes to directly. Gateway stdout stays
   clean.
5. **Latency is acceptable.** 16 s end-to-end with a single-
   turn coding ask. Real plan/execute will be slower
   (multi-turn), but that's the work, not the overhead. The
   2.6 s gap between A and B (12.7 s vs 16.3 s) is mostly
   process spawn — measurable but not blocking.

## What T2 inherits from this spike

- The `query()` invocation pattern (mirror
  `gateway.mjs:85-110`).
- `cwd` set to the project path resolved via projects-index
  (`Variant A` line in `runQuery({ options: { cwd: projectDir } })`).
- `permissionMode: "bypassPermissions"` for parity with the
  parent gateway.
- Coding-flavored system prompt distinct from the parent's
  Soul + Orchestrator.
- Event loop that captures `assistant.text`, `tool_use`, and
  `result` events; writes structured JSON lines to a per-
  execution log file.
- Process-tree kill on user-triggered abort.

## What T2 does NOT inherit

- The temp-clone scaffolding (`_temp.mjs`) is for the spike
  only. T2 operates against the actual project path.
- The "ask the model who it is" identity-preservation probe is
  for the spike only. Phase 4 verification (T7) re-runs a
  similar probe end-to-end against the assembled Operative.

## Open items routed forward

- **Heartbeat / SDK process-tree cleanup.** T6 must verify
  `ps -ef | grep claude` is clean after a kill. If MCP server
  child processes survive, kill the whole process group, not
  just the immediate child.
- **Cost telemetry.** SDK returns `total_cost_usd` in the
  `result` event. T2 should write this into the log so we
  can sum coding-subagent spend over time.
- **Model choice.** Spike used `sonnet`. T2's
  `config_schema.subagent_model` defaults to `opus` per the
  plan; the dogfood composition can override.

## How to delete this spike

```sh
rm -rf scripts/spike/sub-agent/
```

The symlink at `scripts/spike/sub-agent/node_modules` points
into the gateway fitting's install — deleting the spike does
not affect the gateway.
