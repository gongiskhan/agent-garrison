# Web Channel Session Parity — Progress

Branch: `web-parity`
Host: `dev-madrid` (`/home/ggomes/dev/garrison`, authoritative Linux checkout)
Started: 2026-08-16

## Operating state

- Live sessions spawned by this run: **0 / 5 maximum**.
- `PRD.md`, `PLANING.md`, and `TASKS.md`: absent at startup.
- CodeGraph: unavailable in this checkout/tool session; repository search is the fallback.
- Pre-existing user change preserved: `compositions/default/apm.yml` changes Agent SDK account from empty to `auto`. It is not part of a milestone unless later evidence makes it part of the required model-swap config.
- No deployment or live-data mutation is authorized by this plan. M8 may exercise isolated live sessions only.
- UI work follows the existing fitting stack with accessible controls and phone-viewport behavior; no dependency or design-system migration is planned.

## Config edits pending manual revert

None yet. The Opus 5 live-spawn precondition has not been applied.

## Milestone status

| Milestone | Status | Files touched | Verification | Next step |
|---|---|---|---|---|
| M0 — Gap map | done | `PROGRESS-WEB-PARITY.md` | 8 focused files / 216 tests green; `git diff --check` green | Apply the Opus 5 precondition, capture one SDK fixture, and build the channel-neutral event layer. |
| M1 — Event layer | pending | — | — | Await M0. |
| M2 — Rendering | pending | — | — | Await M1. |
| M3 — Permissions | pending | — | — | Await M2 and design gate. |
| M4 — Interrupt/input | pending | — | — | Await M3. |
| M5 — Continuity | pending | — | — | Await M4. |
| M6 — Routes/errors | pending | — | — | Await M5. |
| M7 — Prefix guard | pending | — | — | Await M6. |
| M8 — Live validation | pending | — | — | Await offline milestones. |
| M9 — Report | pending | — | — | Await M8. |

## M0 — Gap map

### Current message path

One normal threaded send travels through these concrete functions:

1. `fittings/seed/web-channel-default/ui/main.tsx:ThreadedApp` restores the thread and sticky routing, then mounts `ClaudeChat` with `createOrchestratorTransport`.
2. `packages/claude-chat/src/ClaudeChat.tsx:send` creates the local turn and calls `ui/orchestrator-transport.ts:createOrchestratorTransport.send`.
3. `fittings/seed/web-channel-default/scripts/server.mjs:handleChat` persists the user text, merges routing, invisibly builds a bounded prior-message/card context with `assembleMaterializedContext`, then POSTs `buildGatewayChatBody` to gateway `/chat/stream`.
4. `fittings/seed/http-gateway/scripts/gateway-pty.mjs:runTurn` routes through `execRoutedTurn`; an Agent SDK target calls `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs:RoutedGateway.runAgentSdkTurn`.
5. `runAgentSdkTurn` looks up an in-process session keyed by target, thread key, cwd, model, account, effort, prompt/tool policy, and related spawn fields, then calls `AgentSdkAdapter.sendTurn` and `awaitResponse`.
6. `fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs:_consume` creates a fresh SDK `query({prompt: string, options})` for every turn. Later turns set `options.resume` to the most recently observed SDK session id; this is not a standing streaming-input query.
7. The gateway reduces SDK output to `chunk`, `activity`, early `route`, and terminal `done`/`error`. `server.mjs:pipeChatSse` forwards every upstream frame into the thread's in-memory live tail, but durably stores only user/final-assistant text, route metadata, and the last SDK session id.
8. `ui/orchestrator-transport.ts:handleEvent` recognizes only `chunk`, legacy `tool`, `route`, `activity`, `done`, and `error`; `ClaudeChat` renders text/route state, an ephemeral one-line working hint, and the PTY-only `AskUserQuestion` picker. All other named events are ignored.

### Event gap table

The canonical transcript vocabulary is the dependency-free `SessionEvent` shape from `fittings/seed/web-channel-default/lib/session-transcript.mjs:parseTranscriptLines`: stable event id, role, timestamp, and blocks. Existing blocks are `text`, `thinking`, `tool_use`, `tool_result`, `tool_progress`, and `related_task`; `tool_result.images[]` carries whole base64 images. Text, thinking, tool input, and joined tool-result text are capped at 20,000 code units with an explicit truncation suffix; images are not truncated.

| Session event | Agent SDK / bridge emission today | Web Channel disposition today | UI rendering today | Parity gap / target seam |
|---|---|---|---|---|
| Text delta | SDK can emit `stream_event` raw content deltas when `includePartialMessages` is true, and emits final `assistant.message.content[].text`. `AgentSdkAdapter.buildQueryOptions` does not request partials; `_consume` emits accumulated assistant-envelope text through `onText`. `RoutedGateway.runAgentSdkTurn` maps it to `onChunk(text, true)` and gateway `/chat/stream` emits `chunk`. | `server.mjs:pipeChatSse` forwards and buffers `chunk`; only `done.reply` is durable. A visible chunked reply can disappear on reload if terminal reply is blank/missing. | `orchestrator-transport.ts:handleEvent` converts the accumulator to `ChatEvent.assistant`; `ClaudeChat` renders Markdown in the active bubble. | Request raw partials, normalize stable accumulated `text` blocks, persist the canonical final event, and replay/backfill without replacing unrelated later blocks. |
| Thinking delta / block | SDK exposes `thinking_delta` in `stream_event` and final `thinking` / `redacted_thinking` assistant blocks. `_consume` forwards only final-block text; gateway keeps only the last nonblank line, capped to 160 chars, as `activity`. | `pipeChatSse` forwards the hint but does not persist it. Full thinking exists only later in the JSONL parser. | `ClaudeChat` shows an ephemeral working label. `SessionTranscript.tsx:ThinkingBlock` can render a collapsible full block only in the separate transcript viewer. | Emit canonical accumulated `thinking` blocks live and merge them with transcript recovery; render them visibly and collapsibly in the main thread. |
| Tool-use start | SDK raw `content_block_start` identifies the call immediately; the final assistant block contains `{id,name,input}`. `_consume` waits for the assistant envelope and reduces it to `{name,id}`; gateway emits `activity {kind:"tool"}`. | Forwarded only as ephemeral `activity`; not durable. | Main thread shows a working hint. `SessionTranscript.tsx:ToolCall` renders the real call only from JSONL. | Emit a canonical `tool_use` block at start with stable tool-use id and update the same block as input arrives. |
| Tool-use input | SDK raw `input_json_delta` and the final `tool_use.input` carry it. `_consume` discards input entirely. | No frame, storage, or recovery in the chat path; JSONL parser later pretty-prints final input. | No live main-thread rendering. Transcript viewer can show it after journal polling. | Accumulate streamed JSON input under the same canonical `tool_use` block and derive a one-line summary without losing full input. |
| Tool result — text | SDK returns tool-result content in top-level `user` messages and can emit progress/other structured results. `_consume` has no `user` branch and drops all results/progress. | No chat frame or durable event. The separate `handleSessionStream` parser can recover completed JSONL `tool_result` / `tool_progress` blocks. | Only `SessionTranscript.tsx` links recovered results to tool-use ids. | Emit canonical `tool_result` / `tool_progress` events live, persist results, and merge any missed events from every transcript in the session-id chain. |
| Tool result — image | SDK tool-result content can include base64 image blocks; `_consume` drops the containing user message. | No live/durable chat event. `session-transcript.mjs:parseBlock` preserves `{mediaType,data}` when polling JSONL. | Base64 images render inline only in `SessionTranscript.tsx:ToolCall`; ordinary assistant absolute paths use the unrelated `/file` renderer. | Carry the canonical result images unchanged through the event layer and render them inline in the main thread. |
| Permission request | SDK `canUseTool(toolName,input,{signal,suggestions,title,description,toolUseID,...})` blocks until a `PermissionResult`; returning all `suggestions` as `updatedPermissions` is the SDK's “always allow” path. `buildQueryOptions` wires no callback and routed turns hard-code `permissionMode:"bypassPermissions"`. | No generic permission frame, pending state, or answer endpoint. Gateway's JSONL `AskUserQuestion` watcher and `/chat/answer` drive a PTY keyboard picker only. | No tool-permission UI. The existing question picker is not a permission prompt. | Wire `canUseTool` into the canonical stream, persist pending/resolved prompt state, and resolve through a thread-bound answer endpoint; never auto-answer or expire it. |
| Turn end | SDK emits a `result` and, in standing streaming mode, `system/session_state_changed` with `idle` as the authoritative boundary. `_consume` reads part of `result`, ignores idle, then waits for iterator exhaustion. Gateway emits `done`. | `pipeChatSse.persistDone` stores the final assistant reply/route and clears the process-local running stream. | `handleEvent(done)` replaces the bubble with canonical reply and clears busy. EOF without `done` only clears client busy; the server separately stores a failure note. | Emit one typed canonical turn-end event, keyed to a generation, after all prior blocks; use SDK idle/result semantics and preserve stopped/interrupted state. |
| Error / crash | SDK exposes assistant errors, error result subtypes and arrays, API retry/system failure events, plus iterator throws. `_consume` ignores assistant error metadata and most result detail; iterator failure reaches gateway catch as generic `error`. | Server forwards generic `error` and persists `_Turn did not complete: …_`; crash/restart cannot recover the live producer. | `ClaudeChat` appends generic italic error text. No distinct crash/runtime state or actionable fields. | Normalize typed runtime, session-crash, retry, and execution-error events; persist terminal errors and always clear the exact generation's running state. |
| Rate limit | SDK emits top-level `rate_limit_event` with status/reset/type/utilization and may tag assistant errors as `rate_limit`. `_consume` drops both. | No named frame or durable state; an HTTP 429 becomes a generic upstream/chat error. | No limit-specific event, reset time, or recovery text. | Emit/persist a distinct canonical rate-limit block/event with the SDK fields needed for an actionable thread notice. |

### Session spawn and fixed assembly

- `RoutedGateway.runAgentSdkTurn` owns an LRU `Map` of at most eight Agent SDK session state objects. A thread id is only the `sessionKey` portion of the cache key; the Web Channel does not own or hydrate the runtime object.
- `AgentSdkAdapter.spawn` merely builds state. Actual process/query creation happens in `_consume` on each turn. A current query is interrupted with AsyncGenerator `.return()`, not the SDK's `Query.interrupt()`, and `teardown()` does not stop a running query.
- After gateway restart or LRU eviction, the thread's stored SDK id is ignored and the next turn starts fresh. While the map survives, each new query resumes the last id. A resume may announce a new id, but thread state stores only `claudeSessionId` last-write-wins instead of an append-only chain.
- `AgentSdkAdapter.spawn` selects `buildHarness`: `coding` is the `claude_code` preset with `settingSources:["user","project"]`; `full` uses project only; `lean` uses a fixed small prompt and disables built-ins. `buildQueryOptions` adds fixed cwd/model/tool allow/deny/MCP values when supplied.
- Normal routed Agent SDK turns do not receive the composition's assembled Garrison system prompt or generated MCP config. Those are wired only into a separate primary warm adapter/PTY seam. Project/user settings may independently discover tools/MCPs.
- The Web Channel additionally sends dynamic, invisible `assembleMaterializedContext` text on every turn. `ClaudeChat.send` also invisibly prepends a textual effort directive. Both violate the settled no-invisible-injection rule and are removal targets.

### Thread durability and reload boundary

- `scripts/threads.mjs` atomically writes one unschematized JSON file per thread under `$GARRISON_HOME/web-channel/threads`: base metadata, flat `{role,text,ts}` messages, sticky sanitized routing, optional per-message route/overrides, a 512-entry idempotency-key tail, and one last `claudeSessionId`.
- It does **not** store canonical session events, tool results, images, pending permissions, queue state, a session-id chain, or running generation. `runningSince` and the upstream response are process-local.
- `main.tsx:toHistory` reconstructs text turns only. A 10-second idle poll reloads message-count changes. During a same-process turn, `createOrchestratorTransport.resume` replays the live tail once; it does not retry unexpected disconnects or backfill missing history.
- `server.mjs:handleSessionStream` can reread a complete JSONL from byte zero and then poll only complete newline-terminated records. It resolves a thread to only its last id, never follows a chain, never observes turn settlement, and serves the side viewer rather than reconstructing the main thread.

### SSE snapshot/replay boundary

- `lib/live-event-stream.mjs:LiveEventStreamRegistry` keeps a process-local tail per thread: at most 2,048 frames and roughly 8 MiB, evicting the oldest prefix while retaining at least one whole oversized frame.
- `subscribe` atomically snapshots the retained tail and attaches a follower, but neither endpoint nor browser honors `Last-Event-ID`, signals eviction gaps, or deduplicates a replay. `finish` immediately deletes settled state, so this can never be durable history.
- `start(threadId)` supersedes the prior stream and resets ids. Producers append/finish by thread id rather than generation, so overlapping sends can interleave into the replacement stream and an older turn can delete the newer turn. The target uses generation-scoped writes, following Kanban's `runSeq` pointer precedent.
- Complete-history recovery must therefore come from durable thread events plus all JSONL transcripts in the session-id chain; the SSE registry remains only the low-latency live tail.

### Route selection today

- `ClaudeChat` exposes routing behind a `Route` toolbar toggle; the editable `AttributionRail` remains visible while busy or whenever any pin exists. Settled rails are read-only.
- `AttributionRail:menuForField` edits duty/level or flow, target/model, effort, account, tier, project, and related pins. Changes made while busy are marked “next” and cannot alter the active turn.
- `main.tsx:savePins` updates local state and fire-and-forgets a whole-set thread routing PUT. The JSON routing object survives reload, but save failures are silent, the rail's open state is not durable, and a Discuss shortcut replaces the whole pin set.
- Each send snapshots current pins; `server.mjs:mergeTurnRouting` overlays request pins on stored pins and the gateway applies them for that turn. Model/account changes silently select a different session-cache key—there is no explicit start-new-session gate. Effort is also part of today's cache key even though it must become the sole request-level dial.
- Busy desktop Enter and voice input can currently start overlapping sends even though the Send button becomes Stop. Assistant text events have no generation stamp, producing overwrite/interleave hazards rather than an explicit queue.

### DESIGN GATE — target event flow

1. Considered extending `chunk/activity`, rendering JSONL alone, and a single canonical `SessionEvent` stream with JSONL recovery.
2. Chosen: canonical events; the other two either preserve lossy parallel vocabularies or cannot provide low-latency permission/input control.
3. The Agent SDK adapter will normalize partial and final SDK messages into stable-id events whose blocks match the transcript parser.
4. Permission, rate-limit, error, and turn-boundary blocks extend that same vocabulary; channels receive no runtime-private objects or callbacks.
5. The gateway forwards those events unchanged and keeps only resolver/control handles keyed by thread plus generation.
6. Thread state owns sticky spawn route, append-only session ids, visible messages, durable events, pending permissions, and queued inputs.
7. The SSE registry owns only generation-scoped live delivery and bounded replay; it is never treated as history.
8. Reload merges thread events with transcript-derived events from every session id, stable-id latest-wins and ordered by durable sequence/time.
9. One long-lived SDK streaming-input query is owned per Web thread; restart resumes the latest id and appends any newly minted id.
10. Model/account changes create a new explicit generation/session; effort changes only the next request and never changes prefix assembly.
11. Dynamic materialized context and hidden effort text are removed; system prompt and complete tool/MCP options are frozen at spawn.
12. This choice is falsified if the pinned SDK cannot remain open across idle/result boundaries or cannot block `canUseTool`; M1 fixtures and one bounded live capture test those seams first.

### M0 verification

`npm test -- tests/agent-sdk-runtime.test.ts tests/gateway-run-context.test.ts tests/web-channel-orchestrator-transport.test.ts tests/web-channel-run-context.test.ts tests/web-channel-threads.test.ts tests/web-channel-live-resume.test.ts tests/web-channel-ui-run-context.test.ts tests/claude-chat-run-context.test.ts` — **8 files, 216 tests passed**. `git diff --check` also passed before the milestone commit.

## Resolved questions

- **Which checkout may execute tests?** This process is on `dev-madrid`, not macOS, so the repository's Linux commands are permitted here. Production deployment remains separately unauthorized.
- **How should historical notes be treated?** Basic Memory was searched first. Its Web Channel notes describe the prior per-turn architecture and rich transcript renderer, but current repository and runtime evidence remain authoritative.

## Open questions

- The authentic partial-message ordering and whether one streaming-input query remains open across `result`/`idle` are intentionally left to M1's single bounded fixture capture.
- The exact priority/timing semantics for input submitted during a running SDK turn remain M4's offline fixture task after M1 records the standing query shape.
