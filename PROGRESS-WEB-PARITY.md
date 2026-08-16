# Web Channel Session Parity — Progress

Branch: `web-parity`
Host: `dev-madrid` (`/home/ggomes/dev/garrison`, authoritative Linux checkout)
Started: 2026-08-16

## Operating state

- Live sessions spawned by this run: **1 / 5 maximum**.
- `PRD.md`, `PLANING.md`, and `TASKS.md`: absent at startup.
- CodeGraph: unavailable in this checkout/tool session; repository search is the fallback.
- Pre-existing user change preserved: `compositions/default/apm.yml` selects the
  named `pro-ekoa` Codex account and changes the Agent SDK account from empty to
  `auto`. It is not part of this Web-parity work and remains unstaged.
- No deployment or live-data mutation is authorized by this plan. M8 may exercise isolated live sessions only.
- UI work follows the existing fitting stack with accessible controls and phone-viewport behavior; no dependency or design-system migration is planned.

## Config edits pending manual revert

The live-spawn precondition was applied before M1's first session. Revert these by hand after the run if Fable should become primary again:

```text
compositions/default/apm.yml
  target id fable: model claude-fable-5 -> claude-opus-5
compositions/default/.garrison/routing.json
  target ids fable, fable-low, fable-med: model claude-fable-5 -> claude-opus-5
compositions/default/.garrison/policy.json
  discuss T0/T1/T2 cells and targets fable/fable-low/fable-med: model claude-fable-5 -> claude-opus-5
```

The legacy target ids remain unchanged so authored matrix references and sticky Web routing continue to resolve, but every active occurrence now launches Opus 5. Historical decisions and backup files were intentionally not rewritten.

## Milestone status

| Milestone | Status | Files touched | Verification | Next step |
|---|---|---|---|---|
| M0 — Gap map | done | `PROGRESS-WEB-PARITY.md` | 8 focused files / 216 tests green; `git diff --check` green | Apply the Opus 5 precondition, capture one SDK fixture, and build the channel-neutral event layer. |
| M1 — Event layer | done | Opus config; Agent SDK normalizer/adapter; gateway event forwarding; Web thread event store; capture script/fixture; focused tests | 10 files / 216 tests green; full typecheck + diff check green; live count 1 | Render the canonical stream in the main thread from fixtures. |
| M2 — Rendering | done | canonical per-turn timeline; shared safe Markdown; durable identity/hydration; accessible transcript controls; rebuilt Web/Dev Env/Kanban assets | 17 focused files / 362 tests; full suite 514 files / 5,728 tests green (6 files / 21 tests skipped); typecheck, 3 builds, and diff check green | Implement durable, non-expiring SDK permission prompts with explicit allow/deny resolution. |
| M3 — Permissions | done | Agent SDK permission bridge; generation-bound gateway resolver; durable thread revisions; Web answer proxy/transports; shared accessible permission cards; rebuilt Web/Dev Env/Kanban assets | 17 focused files / 393 tests; full suite 514 files / 5,759 tests green (6 files / 21 tests skipped); typecheck, 3 builds, and diff check green | Implement running-turn interrupt and queued/streaming input semantics. |
| M4 — Interrupt/input | done | standing Agent SDK Query; durable Web FIFO/input receipts; exact generation stop/replay; recovery-safe transport; queue/voice UI; rebuilt Web/Dev Env/Kanban assets | 16 focused files / 290 tests; full suite 519 files / 5,819 tests green (6 files / 21 tests skipped); voice Playwright 6/6; typecheck, 3 builds, optimized build, and diff check green | Reconcile process-restart ownership and rebuild complete history from the SDK journal chain. |
| M5 — Continuity | done | atomic no-replay restart reconciliation; exact SDK resume/cold-generation barrier; full-chain JSONL recovery; authoritative transcript snapshots; stale-control hardening; rebuilt Web/Dev Env/Kanban assets | 17 focused files / 388 tests; full suite 520 files / 5,855 tests green (6 files / 21 tests skipped); typecheck, 3 builds, optimized build, syntax, and diff checks green | Normalize typed route and failure state without weakening exact generation ownership. |
| M6 — Routes/errors | pending | — | — | Audit the canonical route, rate-limit, retry, runtime-error, and terminal-state seams. |
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

## M1 — Channel-neutral session event layer

### Authentic fixture capture

- Model precondition: all active `fable`/`fable-low`/`fable-med` model values were changed to `claude-opus-5` before the process was launched; target ids stayed stable.
- Live spend: exactly one low-effort Opus 5 Agent SDK session in a disposable `mkdtemp` directory, with one prompt constrained to `Write` then `Read`; the scratch directory was removed after capture.
- Result: 45 SDK messages — 26 `stream_event`, 12 `system`, 3 `assistant`, 2 `user` tool-result messages, 1 `rate_limit_event`, and 1 successful `result`. Tool calls/results were exactly Write + Read.
- Fixture: `tests/fixtures/agent-sdk-web-parity-events.json`; opaque ids and scratch paths are stable aliases, and init account/config/credential fields are never serialized.
- Observed ordering: each raw `message_start` and final `assistant` share `message.id`, while wrapper UUIDs differ. Canonical live updates therefore key assistant events by `message.id`; final envelopes replace the partial snapshot instead of adding a duplicate.
- The string-prompt capture did not emit `session_state_changed`; the pinned SDK type explicitly documents `idle` as authoritative for a standing streaming-input query, which M4 will exercise offline with a fake query.

### M1 failure diagnosis — SDK import isolation

- Expected: the existing adapter suite accepts the capture script after it was routed through `lib/sdk-client.mjs`, the sole package-import seam.
- Actual, twice: the same source guard still reported `scripts/capture-web-parity-fixture.mjs` as a direct SDK import.
- Ranked causes: (1) the fixture metadata literal contains the scoped package name and the guard scans text, not syntax; (2) the import edit was stale; (3) another generated copy was scanned.
- Cheapest discriminator: `rg -n '@anthropic-ai' fittings/seed/agent-sdk-runtime/scripts/capture-web-parity-fixture.mjs`.
- Result: only the metadata `source` literal remained, confirming cause 1. Rephrase that nonfunctional label, then perform one final focused retry instead of patch/retry looping.

### M1 implementation result

- `agent-sdk-runtime/lib/session-events.mjs` now owns the provider-neutral normalizer. Raw text/thinking/input deltas revise one stable assistant event; settled envelopes reuse `message.id`; tool results/images/progress, status, runtime errors, rate limits, and turn boundaries use the transcript block vocabulary plus typed extensions.
- The normalizer uses the parser's exact 20,000-character honest truncation marker. Base64 result images stay whole. Unknown top-level SDK messages become `status` blocks rather than disappearing; protocol-only stop/signature boundaries create no empty visual event.
- `AgentSdkAdapter.buildQueryOptions` requests partial messages. `sendTurn` accepts safe optional `onEvent` and `turnId` hooks while preserving legacy text/tool/thinking/session callbacks and its settled response contract.
- `RoutedGateway.runAgentSdkTurn` passes the canonical callback through unchanged. Gateway `/chat/stream` publishes immediate `session_event` frames beside the legacy stream, so other channels can consume the same payload without importing Web rendering code.
- `threads.mjs` sanitizes and atomically merges durable `sessionEvents` by stable id/higher revision at the original timeline position. It also records unique append-only `sessionIds` while keeping `claudeSessionId` as the latest compatibility field.
- `server.mjs:pipeChatSse` queues each canonical event into the same serialized write chain as route/session/final-message writes; its in-process SSE tee still forwards the payload verbatim first. Malformed canonical payloads remain observable live but are refused for durable storage.
- On-disk JSONL remains the recovery source with the same core block shapes. M5 will join every file in `sessionIds` and reconcile transcript events with this durable live journal; M1 deliberately does not pretend the bounded SSE tail is history.

### M1 verification

`npm test -- tests/agent-sdk-session-events.test.ts tests/agent-sdk-runtime.test.ts tests/runtime-cancel.test.ts tests/api-runtime-compaction.test.ts tests/gateway-agent-sdk-route.test.ts tests/gateway-run-context.test.ts tests/web-channel-threads.test.ts tests/web-channel-run-context.test.ts tests/web-channel-live-resume.test.ts tests/web-channel-orchestrator-transport.test.ts` — **10 files, 216 tests passed**. `npm run typecheck -- --pretty false` and `git diff --check` passed. No live process was launched after the one fixture capture.

## M2 — Rendering text, tools, and thinking

- Chosen rendering seam: reuse the shared `SessionTranscript` vocabulary inside each chat turn rather than maintain a second tool/thinking renderer. Canonical text, thinking, tools, results, images, typed errors, and terminal results now render chronologically in the primary chat; older/non-SDK turns retain the legacy text path.
- Live revisions merge by stable event id and monotonically increasing revision, keeping the outer timeline and Markdown node mounted while partial code fences grow. Tool results associate by `toolUseId`, so a late result attaches to its earlier call without reordering intervening text. Successful `turn_end.result` is authoritative over stale legacy drafts for rendering, copy, TTS, completion callbacks, and composer context; differing failure/cancellation fallbacks remain visible.
- Canonical Markdown now uses the established chat renderer and its syntax-highlighted copy cards, safe-scheme/HTML policy, `garrison://` translation, and live loopback-to-tailnet host map. Structured prose receives only the route/orchestrator badge scrub, not the TUI-noise heuristics used on legacy scraped text.
- Durable reload hydration groups stored events by turn coordinate and timestamps, tolerates one SDK turn rolling through several session ids, and disambiguates browser turn counters reused after remount. Synthesized event ids carry a per-normalizer scope; user rows persist their turn coordinate; malformed event shapes are dropped at both transports.
- Thread mutations are serialized per normalized thread id so concurrent event, routing, session, and message writes cannot erase one another. Stale/equal event revisions are total no-ops. Idle/resume refresh compares durable message plus event revisions rather than message count, and an upstream EOF without a terminal frame is surfaced, persisted, settled, and replayable instead of leaving polling suppressed.
- Completed tool calls and thinking blocks default closed; active calls may remain open. Full output and inline base64 images live inside disclosures. Image and related-task overlays are native modal dialogs with initial focus, Tab containment, Escape/backdrop close, scroll lock, and opener restoration. One polite live region owns turn announcements; coarse-pointer controls are at least 44×44 px; genuine 320px browser coverage checks overflow, disclosure state, focus, contrast, and modal behavior.

### M2 verification

- `npm test -- tests/agent-sdk-session-events.test.ts tests/agent-sdk-runtime.test.ts tests/runtime-cancel.test.ts tests/api-runtime-compaction.test.ts tests/gateway-agent-sdk-route.test.ts tests/gateway-run-context.test.ts tests/web-channel-threads.test.ts tests/web-channel-run-context.test.ts tests/web-channel-live-resume.test.ts tests/web-channel-orchestrator-transport.test.ts tests/web-channel-ui-run-context.test.ts tests/claude-chat-journal.test.ts tests/claude-chat-sanitize.test.ts tests/claude-chat-run-context.test.ts tests/claude-chat-rail.test.ts tests/claude-chat-session-events.test.ts tests/claude-chat-session-events-browser.test.ts` — **17 files, 362 tests passed**.
- `node fittings/seed/web-channel-default/ui/build.mjs`, `node fittings/seed/dev-env/ui/build.mjs`, and `node fittings/seed/kanban-loop/ui/build.mjs` rebuilt every consumer of the shared renderer. `npm run typecheck -- --pretty false` and `git diff --check` passed.
- Repository-wide `npm test` — **514 files, 5,728 tests passed; 6 files / 21 opt-in tests skipped**. No process was deployed and no additional live model session was launched.

## M3 — Durable interactive tool permissions

- Only a streamed Web Agent SDK turn with an exact non-empty thread id now runs with `permissionMode: "default"`. Headless/JSON calls and every other channel keep the established `bypassPermissions` behavior. The adapter's `canUseTool` bridge publishes a provider-neutral pending request and blocks on its resolver without leaking the SDK callback or permission objects across the runtime boundary.
- Each streamed turn receives a gateway-owned opaque generation id. Resolver handles are process-local and keyed by the exact thread, generation, and request id; a decision is atomically consumed once. The browser may submit only `allow_once`, `allow_always`, or `deny`. Approval returns private snapshots of the exact disclosed input and, for `allow_always`, the exact original SDK suggestions—never caller-mutated or browser-supplied replacements.
- Permission requests use generation-namespaced stable event ids. A pending event at revision 1 is replaced in place by a resolved or cancelled revision 2, preserving its original order in the durable thread journal and live SSE stream. The Web proxy binds answers to the route's thread and request id before forwarding them to the gateway.
- Public input and suggestions are JSON-safe, bounded disclosures with explicit `inputComplete` and `suggestionsComplete` authority flags. Approval once is unavailable unless input is complete; permanent approval additionally requires a complete, non-empty suggestion list. Unsafe keys, accessors, sparse/custom arrays, excessive depth/size/count, cycles, symbols, and non-finite values fail closed. Deny remains available even when a request can only be shown as an incomplete preview.
- The shared timeline renders chronological permission cards in the primary Web chat. Pending cards expose Deny, Allow once, and conditionally Always allow; each request has an independent busy/error/retry state. Standalone transcript views remain read-only. The same single-live-region, visible-focus, 44px coarse-target, contrast, and true 320px viewport checks used by M2 cover the new controls.
- Restart behavior is intentionally honest at this milestone: the durable pending card survives, but its process-local resolver does not. An answer after a gateway restart receives `409` instead of being forged, expired, or silently auto-denied. Rebinding pending controls across restart belongs to M5 continuity.

### M3 verification

- `npm test -- tests/agent-sdk-session-events.test.ts tests/agent-sdk-runtime.test.ts tests/runtime-cancel.test.ts tests/api-runtime-compaction.test.ts tests/gateway-agent-sdk-route.test.ts tests/gateway-run-context.test.ts tests/web-channel-threads.test.ts tests/web-channel-run-context.test.ts tests/web-channel-live-resume.test.ts tests/web-channel-orchestrator-transport.test.ts tests/web-channel-ui-run-context.test.ts tests/claude-chat-journal.test.ts tests/claude-chat-sanitize.test.ts tests/claude-chat-run-context.test.ts tests/claude-chat-rail.test.ts tests/claude-chat-session-events.test.ts tests/claude-chat-session-events-browser.test.ts` — **17 files, 393 tests passed**.
- The gateway route suite includes a child-process proof from streamed SDK callback to pending SSE, a wrong-tuple `409`, valid answer POST, resolved revision, and terminal completion. Adapter/store tests cover exact disclosure, generation/request reuse, stale revisions, and incomplete-data refusal.
- `node fittings/seed/web-channel-default/ui/build.mjs`, `node fittings/seed/dev-env/ui/build.mjs`, and `node fittings/seed/kanban-loop/ui/build.mjs` rebuilt every shared-chat consumer. `npm run typecheck -- --pretty false` and `git diff --check` passed.
- Repository-wide `npm test` — **514 files, 5,759 tests passed; 6 files / 21 opt-in tests skipped**. No process was deployed and no additional live model session was launched.

## M4 — Generation-safe interrupt and queued input

- Web input is now a durable per-thread FIFO rather than an overlapping set of
  anonymous fetches. The browser retries one opaque `clientRequestId`; the Web
  store admits it once as an `inputId`; and the gateway owns a distinct opaque
  `generationId`. Admission, live replay, canonical events, Stop, permissions,
  questions, persistence, and terminal receipts retain those exact coordinates.
- One input runs per thread while separate threads remain concurrent. The first
  successful gateway `open` binds the generation; malformed ordering, a second
  `open`, pre-open hangs, lost admission responses, reader failures, and transient
  resume failures all fail or retry without duplicating the operative turn. An
  authoritative reply write must succeed before the FIFO advances.
- Streamed Web Agent SDK work uses the pinned SDK's standing `streamingInput`
  Query and treats `session_state_changed: idle` as the reusable boundary. Warm
  compatible turns send only their new input. A cold replacement receives the
  bounded durable thread context once, including after active-safe LRU eviction;
  raw credentials never enter the compatibility key and token rotation retires
  the old session through a process-local non-reversible fingerprint.
- Stop is exact-generation only, coalesces concurrent attempts, and memoizes only
  success so an explicit retry can reach a newly usable primitive. Native vision
  reports its non-cancellable state honestly. AskUserQuestion display and answer
  actuation are turn-scoped, require the exact tool/thread owner, and never fan out
  across concurrent streams or drive a different PTY session.
- Hydration preserves queued/running/terminal input state and pairs keyed replies
  even when unrelated assistant-only notifications interleave. The shared chat
  blocks stale question/permission/Stop controls synchronously at terminal state,
  preserves the exact reply identity for voice, keeps queue-locked voice controls
  mounted, and provides keyboard-operable PTT and attachment removal at a real
  320px viewport.

### M4 verification

- Focused regression gate: **16 files / 290 tests passed**; voice Playwright:
  **6/6 passed**.
- `node fittings/seed/web-channel-default/ui/build.mjs`,
  `node fittings/seed/dev-env/ui/build.mjs`, and
  `node fittings/seed/kanban-loop/ui/build.mjs` rebuilt all shared-chat consumers;
  the optimized repository build, full typecheck, syntax checks, and
  `git diff --check` passed.
- Repository-wide `npm test` — **519 files, 5,819 tests passed; 6 files / 21
  opt-in tests skipped**. No process was deployed and no additional live model
  session was launched.

## M5 — Restart-safe continuity and complete transcript recovery

- Startup reconciliation never replays uncertain side effects. Persisted
  `starting`, `running`, or `stopping` inputs atomically become visible failed
  turns, their pending permission controls are cancelled, and queued successors
  remain behind a durable recovery gate. The Web process probes exact
  `{threadId,inputId}` gateway ownership and requests exact recovery; conflicts
  and unavailable ownership retry with bounded backoff for the server lifetime,
  and only authoritative release clears the gate. Corrupt or unreadable thread
  storage fails startup closed.
- Standing SDK continuity now distinguishes an ordinary cold process from a
  contaminated interrupted generation. Exact, fully compatible durable SDK
  attribution uses the pinned SDK's native resume option and appends any refined
  session id. A restart barrier retires a still-warm contaminated Query and
  forces a clean journal generation; incompatible or malformed attribution cold
  starts with bounded materialized context once instead of silently attaching
  to the wrong conversation.
- Thread history joins every unambiguous local JSONL in the append-only session
  chain. The durable canonical store remains authoritative for terminal and
  control state; recovery may add missing events or strictly complete a partial
  snapshot, but refuses cross-session collisions, ambiguous transcript files,
  changed parseable tool inputs, unsafe truncation claims, and reordered stable
  slots. Whole recovered turn groups bind to claimed-input time intervals, so
  queued successors, same-millisecond boundaries, SDK session rollover, and
  legacy history cannot steal one another's events.
- Transcript polling is serialized and emits authoritative ordered snapshots,
  allowing the shared renderer to replace, remove, or move recovered rows rather
  than append stale deltas. Schedulable FIFO handoffs keep the stream alive;
  parked queues end honestly and reconnect when ownership clears; an idle
  transcript reconnects on a later `live:false` to `live:true` transition. Stale
  permission, question, and Stop controls are synchronously disabled against the
  exact parent generation after recovery or terminal state.
- Deliberate boundaries remain fail closed: an SDK provider failure after native
  resume has begun is surfaced rather than automatically cold-retrying a turn
  that may already have side effects. A full gateway restart cannot detect a
  credential rotation hidden behind the same durable account alias, and prompt
  or tool-policy changes are not yet part of durable SDK compatibility identity.

### M5 verification

- Focused regression gate: **17 files / 388 tests passed**, including real
  Chromium coverage for recovered terminal controls, authoritative snapshot
  replacement, parked-stream recovery, and idle-to-live reconnection.
- `node fittings/seed/web-channel-default/ui/build.mjs`,
  `node fittings/seed/dev-env/ui/build.mjs`, and
  `node fittings/seed/kanban-loop/ui/build.mjs` rebuilt all shared-chat consumers;
  the optimized repository build, full typecheck, MJS syntax checks, and
  `git diff --check` passed.
- Repository-wide `npm test` — **520 files, 5,855 tests passed; 6 files / 21
  opt-in tests skipped**. No process was deployed and no additional live model
  session was launched.

## Resolved questions

- **Which checkout may execute tests?** This process is on `dev-madrid`, not macOS, so the repository's Linux commands are permitted here. Production deployment remains separately unauthorized.
- **How should historical notes be treated?** Basic Memory was searched first. Its Web Channel notes describe the prior per-turn architecture and rich transcript renderer, but current repository and runtime evidence remain authoritative.

## Open questions

- M6 must decide which SDK route, retry, rate-limit, execution-error, and crash
  fields belong in the provider-neutral durable vocabulary, while retaining M4's
  exact input/generation settlement rules.
