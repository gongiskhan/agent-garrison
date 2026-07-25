# 2026-07-25 - Web Channel run context: attribution badges, per-turn overrides, real cancel

**Status**: implementing. This file is the CONTRACT every layer builds against.
Field names here are normative - do not rename them in one layer only.

## Problem

A web-channel turn is opaque. The reply arrives with a single text chip
(`routeChipFromAttribution` -> "agent-sdk/sonnet - T2-standard - high effort")
and nothing else: no duty, no account, no project; nothing while the turn runs;
nothing after a reload (`appendMessages` rebuilds every message as exactly
`{role,text,ts}`); no way to change any of it; and a Stop button whose
`transport.interrupt()` is an empty no-op.

Three asks, in the user's words: say which runtime/duty/model/account/effort/project
in one line of badges; give buttons and dropdowns to override all of it (stopping
the task if needed, or changing before the next message); and when a turn runs on
another runtime, tie that session's output into this conversation.

## Decisions

1. **Project is a real execution scope.** A picked project becomes the turn's
   `cwd`, confined to git repos one level under the dev-root. Not a prompt label.
2. **Every lane is cancellable.** codex/gemini adapters gain a real kill
   primitive; the agent-sdk query is stashed so it can be aborted; the one-shot
   and standing PTY lanes use ESC plus a liveness fix in `waitForTurnComplete`.
3. **One landed change.** Badges, overrides, cancel and stitching ship together.

Enabled by a fact both earlier designs missed: a web turn takes the **ephemeral
one-shot lane** (`shouldUseEphemeralSession("web") === true`), i.e. a fresh
disposable Claude process per turn, and `oneShotTurn` already accepts `cwd` and
`env` (`packages/claude-pty/src/session.mjs:358-371`). `runWebOneShot` merely
hardcodes them. So `project` and `account` are genuinely per-turn for web turns -
no operative respawn, no read-only badge.

## Contract

### 1. `RunAttribution` (the resolved snapshot of one turn)

Extends the existing `RouteAttribution` in `packages/claude-chat/src/transport.ts`.
Every field optional + nullable: a lane that cannot report one sends null and the
badge is OMITTED (never a fake placeholder).

```ts
export interface RouteAttribution {
  // existing - unchanged
  route?: string | null;          // resolved target id
  runtime?: string | null;        // agent-sdk | claude-code | codex | gemini | ollama-native
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  effortApplied?: boolean | null; // true=applied, false=refused, null=unverified
  taskType?: string | null;
  tier?: string | null;
  ruleId?: string | null;
  profile?: string | null;
  honored?: boolean | null;
  // NEW - known gateway-side today, never reported
  duty?: string | null;
  level?: number | null;
  phase?: string | null;
  skill?: string | null;
  via?: string | null;            // duty-cell | turn-override | classifier
  account?: string | null;        // null renders "machine login"
  accountSource?: "override" | "target" | "process" | null;
  project?: string | null;        // dev-root child NAME
  projectPath?: string | null;    // absolute cwd the turn actually ran in
  card?: string | null;
  cardUrl?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  stoppedByUser?: boolean | null;
  stoppedReason?: string | null;
  // NEW - override bookkeeping. Pinned INTENT is kept separate from what RAN.
  overridesApplied?: string[] | null;
  overridesRejected?: { field: string; reason: string }[] | null;
  // NEW - frame discipline
  pending?: boolean | null;       // true on the pre-turn frame, absent/false on done
  turnSeq?: number | null;        // monotonic; see 5
}
```

### 2. `TurnRouting` (the sparse pinned INTENT)

```ts
export interface TurnRouting {
  target?: string | null;   // a composition targets[] id; picks runtime+provider+model coherently
  model?: string | null;    // free-text escape hatch; overlays the resolved target's model only
  effort?: string | null;   // low | medium | high | xhigh | max  (mirrors dutyEfforts)
  duty?: string | null;
  level?: number | null;    // integer 1..9
  project?: string | null;  // dev-root child NAME only
  account?: string | null;
}
```

`runtime` and `model` are NOT independently settable from a menu: there is no
model catalog anywhere in the repo (model is free text in `POST /api/muster/target`
and in every runtime `config_schema`), so a model dropdown would invite invalid
pairs like `runtime: gemini` + `model: opus`. A target picks all three coherently.
`model` stays as a typed escape hatch for power use.

### 3. Wire path (client -> gateway), 4 existing choke points, no new ones

`ChatSendMeta.routing` (ClaudeChat) -> `payload.routing` (orchestrator-transport)
-> `body.routing` (`buildGatewayChatBody`) -> `hints.routing` (`routeHintsFromBody`,
validated by `sanitizeRouting`) -> `applyTurnOverride` in `preRoute`.

Back-compat pinned by `tests/web-channel-context.test.ts` holds: with no context
and no mode the gateway body stays EXACTLY `{message, channel:"web"}`.

Note: `meta.autonomous` already exists in `ChatSendMeta` and is already produced by
`buildSendMeta`, but `createOrchestratorTransport.send()` silently drops it today.
Live proof this seam loses unforwarded keys with no error. Fix it in the same pass
and pin BOTH keys with a test.

### 4. SSE frames

- `event: route` is emitted **TWICE**: once right after `preRoute` resolves
  (`pending: true`) so badges appear ~1s into the turn instead of at the end, and
  once folded into `done`. The client MERGES (`{...last.route, ...frame}`), so the
  pre-turn frame is refined, never clobbered.
- `event: activity` `{ kind: "tool", name, id }` - tool activity from a routed
  runtime, rendered into the existing (permanently empty on this transport)
  `.cc-working-hint` slot: "Working 0:42 - Edit".
- `event: done` gains every `RouteAttribution` field via ONE helper.

### 5. Turn identity

The current `case "route"` handler writes blindly to `copy[copy.length-1]`
(`ClaudeChat.tsx:921-933`), so a late frame lands on the wrong turn. The transport
stamps a monotonic `turnSeq` per send; a frame whose `turnSeq` is OLDER than the
current turn's is **DROPPED**. Not "fall back to last turn" - that re-opens the bug.

### 6. Gateway attribution: 3 sites, not 9

`done` payload shape is branch-dependent across 6 lane returns
(`gateway-pty.mjs:1038,1083,1129,1176,1264,1343`) + 3 early returns
(`:863,:976,:1398`). Do NOT rewrite 9 sites: add ONE pure helper

```js
function turnAttribution(pre, hints, extra) // -> { duty, level, phase, skill, account, accountSource, project, projectPath, via, card, overridesApplied, overridesRejected }
```

and PREFIX-merge it (`return { ...turnAttribution(pre, hints), ...result }`) at the
THREE returns of `runRoutedTurn`: the steering return (`:866-874`), the
significant-card return (`:976`), and the tail `return result` (`:1013`). The tail
covers all 6 `execRoutedTurn` lanes for free. Result fields always win, so
kanban-loop's fixed-field `routeFromDone` (`gateway-client.mjs:75-96`) cannot break.
The two genuinely-uncovered intercepts (`:1685` discuss, `:1398` legacy) get a test
asserting a mostly-empty rail rather than being discovered later.

### 7. Override honoring

`applyTurnOverride(config, route, ov)` overlays a named `config.targets[]` entry +
effort onto the resolved route, sets `route.via = "turn-override"` and
`route.ruleId = "override:<id>"`, and is called in BOTH lanes immediately after the
route resolves and BEFORE the decision record and the plan/lane selection - so the
override reaches the runtime lane, not just the badge. A duty+level override instead
re-enters `preRouteV4`, the lane the kanban engine already drives.

Rejections are recorded, never silently dropped: `unknown-target`,
`provider-has-no-effort-control` (agent-sdk `SDK_PROVIDERS` marks `effort:false` for
every non-Anthropic provider; gemini has no effort control at all),
`project-not-a-git-repo-under-dev-root`, `account-not-found-in-vault`. The badge
then reads "override rejected: <reason>" instead of lying.

As built, the reason list also carries `account-platform-mismatch` (a non-Anthropic
account pinned onto a Claude lane - so codex/gemini per-turn account switching is
NOT delivered here; those runtimes authenticate out-of-band), `duty-cell-unresolved`,
and four edge-validation reasons from `sanitizeRouting`:
`effort-not-in-vocabulary`, `level-not-an-integer-1-9`, `not-a-non-empty-string`,
`control-characters`, `too-long`.

### 8. Project -> cwd, confined

New `resolveProjectName(label)` in `http-gateway/scripts/lib/project-source.mjs`
accepts ONLY a dev-root child name: rejects absolute paths, any `/`, `..`, and
requires a `.git` dir. The existing `resolveProjectPath` returns ANY absolute
existing path as-is (`project-source.mjs:35-42`); the moment a channel body can set
`project` that is arbitrary-cwd input. Confinement lands in the SAME commit.

### 9. Cancel

`POST /chat/interrupt {sessionId}` backed by a module-level
`activeTurns: Map<sessionId, {lane, stop}>` populated in `runTurn`'s existing
try/finally. Per lane:

| lane | stop primitive |
|---|---|
| standing PTY | `session.writeKeys("\x1b")` (same primitive `/claude/interrupt` uses) |
| web one-shot | ESC on the disposable session exposed via `runWebOneShot`'s `onSession` |
| agent-sdk | stashed query `client.return?.()` + `session.cancelRequested` |
| codex / gemini | NEW `adapter.cancel(session)`: SIGTERM then SIGKILL the stored child |

**`teardown()` cancels nothing.** `AgentSdkAdapter.teardown` is exactly
`if (session) session.alive = false;` and `CodexAdapter.teardown` is exactly
`session.alive = false;` - neither kills a process, and no adapter stores the child
handle (the codex child is a local `const child = spawn(...)` inside a promise).
`runSecondaryTurn` already calls `teardown` in a `finally` with no observable
effect. So the adapters must first STORE the child; only then can cancel be real.

A flag checked inside `for await (const msg of client)` only fires at the next SDK
message boundary - during a long thinking phase nothing cancels. The query object
must be stashed on the session and actively returned.

`waitForTurnComplete` (`packages/claude-pty/src/screen.mjs:326-376`) polls
`captureLines(handle)` every 350ms with NO liveness check and resolves only on
stable+promptSettled+workSatisfied, or on timeout. Disposing the handle mid-turn
freezes the snapshot, so the turn hangs to the 5-minute timeout with the HTTP
request open. Add an `isAlive()` check: a dead handle resolves immediately with the
partial reply.

The turn then settles normally with its partial reply and `stoppedByUser: true`.

### 10. Reload survival - the 7-hop chain, every hop drops it today

1. gateway `done` carries the fields (6).
2. `pipeChatSse.scanForDone` calls `persistDone(payload)` - today `persistDone(payload?.reply)`.
3. `threads.appendMessages` keeps a whitelisted `route` + `overrides` - today the
   `.map` rebuilds exactly `{role,text,ts}`.
4. `main.tsx` `ThreadMessage` gains `route?` / `overrides?`.
5. `main.tsx` `toHistory` carries them onto the pair's assistant side.
6. `ClaudeChatProps.initialHistory` + the seeding map carry them onto `Turn`.
7. render reads `t.route`.

Because `route` rides in the persisted message, the existing 10s `apiGetThread`
poll + `historyRev` remount can no longer wipe badges - today it destroys the
in-memory `Turn.route`.

**Failure persistence**: today NOTHING is persisted when a turn errors or `done`
never arrives - not even the user's message. Add `persistFailed(reason)` on
`event: error`, on upstream >= 400, and on upstream end-without-done, behind the
same `persisted` latch. Cancel is the feature most likely to produce that state.

### 11. Options (one read, not six)

New gateway `GET /route/options`, placed NOT behind `await readyPromise` so the
menu works while the operative spawns:

```
{ targets: [{id, runtime, provider, model, effort, account}],
  duties: [{id, title, levels:[{n, description}]}], selectedDuties: [...],
  efforts: ["low","medium","high","xhigh","max"],
  accounts: [{name, platform}], account: {name, source},
  primaryRuntime, activeProfile }
```

`efforts` mirrors `dutyEfforts` (`src/lib/types.ts:299`) - pin them equal in a test
so they cannot drift.

As built, the gateway also returns `projects: string[]` from its OWN confined
`listProjectNames()` (section 8) rather than only the board's `GET /projects`. The
gateway is the thing that has to resolve the name to a cwd, so it must be the
authority on which names it will accept - a board-sourced name the gateway would
reject is a menu entry that fails on use. The web-channel proxy still merges the
board's list (it carries repos the dev-root scan may label differently) and
degrades to `projects: []` with the row disabled when the board is down, resolving
the board base from `~/.garrison/ui-fittings/kanban-loop.json` exactly like
`handleMonitor` does - never a hardcoded port. It also returns `routing: boolean`,
false when no orchestrator fitting is resolvable, so the rail disables pins rather
than offering ones nothing would honor.

Exposed to the browser as same-origin `GET /api/route-options` on the web-channel
server: the fitting runs at its OWN origin and cannot call Garrison's Next `/api/*`,
and must never be handed an absolute machine-local URL (CLAUDE.md tailnet rule).

### 12. Stitching

**Identity.** The done frame's `session_id` is the routed runtime's OWN session.
Today `setThreadSession` pushes it into ONE thread-level `claudeSessionId`
(last-write-wins), so a multi-turn thread can only point at the newest session.
Persist `sessionId` + `transcriptPath` PER MESSAGE. The badge row then renders a
per-turn `transcript` badge opening the EXISTING
`GET /api/session-stream?session=<id>` - which already globs every dir under
`~/.claude/projects` for `<id>.jsonl` and already accepts an explicit session id.
That is the tie-together mechanic: the spawned session is not a separate place, it
is a drill-down on the bubble it produced.

**Cross-thread bleed (must fix, or the transcript badge points at the wrong
conversation).** Warm agent-sdk sessions are keyed by target only
(`JSON.stringify({targetId, ...spawnArgs})`, `gateway-routing.mjs:616`) with no
conversation identity, so two web threads on the same target share one SDK session
and one `session_id`. Add `sessionKey: hints.sessionId` for channel turns. That
multiplies live sessions by thread count against a Map with no eviction, so add an
LRU cap (8) - and eviction cannot rely on `teardown`, which frees nothing (9).

**Liveness.** No non-primary lane streams: `runAgentSdkTurn` emits the whole reply
in one `onChunk(text, true)` after the turn ends, so the conversation is silent for
minutes then a blob appears. `_consume` already iterates the SDK's structured
stream and sees `block.type === "text"` per assistant block - thread an `onText`
through, and emit `activity` frames for `tool_use` blocks.

**Carded turns.** A significant web ask is CARDED and never runs here: the gateway
short-circuits with a card link and the thread gets only synthesized <=200-char
notices from `notify-origin.mjs`. The rail renders a `card <id>` badge (href passed
through the existing `rewriteHostUrl` - `cardUrl` is a loopback board URL and the
browser is almost never on this box) whose title says plainly that the work runs on
the board. Replaying an engine-driven run into the thread needs a new relay in
`notify-origin.mjs` and is explicitly OUT of this change.

### 13. UI

One new primitive: the **Turn Rail**, a single horizontally-scrolling line of small
mono badges where each badge IS its own dropdown. Rendered twice: a flight rail
inside `.cc-composer` while busy or while any pin is set, and a settled rail per
turn. The settled rail moves OUT of the current
`clean.text.trim() && !t.streaming` gate - that double gate is exactly why routing
is invisible while streaming and on tool-only turns.

- Class prefix is **`.cc-rbadge`**, NOT `.cc-badge`: that class already exists for
  slash-command source badges (9px, uppercase, `--cc-border-strong`) with light-theme
  overrides, and web-channel `ui/styles.css` is concatenated LAST by `ui/build.mjs` -
  the documented specificity trap.
- Menus copy the ONE floating-popup precedent in the package, `.cc-slashmenu` +
  `.cc-slashitem`/`-active` with `menuIdx` keyboard nav anchored to
  `.cc-composer{position:relative}`. No native `<select>`; no emoji anywhere.
- `role="toolbar"` + roving tabindex; each badge `<button aria-haspopup="menu">`;
  under `max-width:560px` the popover becomes a bottom sheet with 44px rows.
- Busy shows `Stop` and `Stop & change` where the single `.cc-stop` is today.
  Nothing auto-resends: `Stop & change` cancels, restores the text into the
  composer, opens the rail, and swaps Send for `Resend`.
- Changing a dimension mid-turn records the pin for the NEXT turn and marks that
  badge `.cc-rbadge-pending` ("applies next turn"). No silent mid-turn re-routing:
  `preRoute` has already resolved and the model may already hold context.
- `.cc-toolbar` is gated on `feat.model || feat.effort || feat.voice || feat.autonomous`
  and `main.tsx` passes NO `features` prop, so the web channel has no toolbar today.
  A new `features.routing` flag must be added to that render gate.
- `createHttpTransport.connect()` subscribes only hello/assistant/status/turn/screen/tool/error;
  add `route` and `activity` or dev-env stays permanently dark on a shared feature.

Scope of a pin: **conversation-sticky**, effective from the next message (matching
"change before a subsequent message"), persisted server-side so it follows the user
across devices over the tailnet. Composition defaults are explicitly NOT editable
here - they live in Muster, mutate `apm.yml` for every future turn, and mostly only
take effect at the next `up()`. The rail links to `/muster` instead.

## Honest limits shipped as limits

- **codex/gemini expose no transcript.** They return `session_id: null` and
  Garrison records neither the `$CODEX_HOME` rollout nor the gemini tmp path. The
  transcript badge renders disabled with that reason. Recording those paths is a
  follow-up, not faked here.
- **Effort is inapplicable on most providers.** `providers.mjs` marks
  `effort: false` for every non-Anthropic provider and gemini has no effort control,
  so those menu items are disabled with the reason rather than offered.
- **`skill` is null on every live cell.** The `duty-*` fittings are not stationed in
  any live composition (`grep "duty-" compositions/default/apm.yml` matches nothing);
  all duties are composition-defined inline with no `skill`. The badge renders
  `skill: none` rather than hiding the fact.
