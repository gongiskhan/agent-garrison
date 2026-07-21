# Scheduling and Kanban Loop Audit

**Date:** 2026-07-20
**Scope:** investigation only - nothing in this audit was fixed, refactored, or cleaned.
**Method:** static read of the repo plus three live signals - `ps aux` (running daemons), `systemctl --user list-timers`, and the live state files under `~/.garrison/`. Where the repo and the live machine disagree, both are reported.

---

## 0. Executive summary

Garrison has **one real scheduler** (`fittings/seed/scheduler/scripts/scheduler.mjs`, a stdlib-only 60s cron daemon) and **one real recurring work engine** (the Kanban Loop tick, `fittings/seed/kanban-loop/scripts/kanban.mjs:449`). Everything else that looks like scheduling is either a UI poll, an in-process supervision timer, a systemd timer, or dead template code.

Four facts that shape any extension work:

1. **The scheduler is already a general, declarative job engine.** Jobs are data (`{id, cron, command, enabled, type}`) in `~/.garrison/scheduler-jobs.json`, re-read on every tick. A general task scheduler does not need a new engine - it needs new job *producers*.
2. **The Kanban card model already carries a work-type discriminator** (`workKind`, `fittings/seed/kanban-loop/lib/board.mjs:111`) and a project discriminator (`project`, `:98`). The requested `kind` field is an extension, not a greenfield.
3. **The board's list set is already dynamic and data-driven** (`buildBoard`, `fittings/seed/kanban-loop/lib/resolved-model.mjs:315`), built from the compiled Orchestrator policy - but every list it can build is a *dev* phase. Non-dev flows have no rail.
4. **There is no weekly/Monday job anywhere**, and no board-level sweep that assembles state or detects stalls by time. Both are genuinely missing.

---

## 1. Inventory of all recurring execution

### 1.1 How active vs dead was determined

Three independent signals, not call-graph reading alone:

- **Live process table.** Two scheduler daemons are running: PID 3138837 (`daemon --health-port 8099`, prod) and PID 2065785 (`daemon --health-port 27999`, codex family). Four fitting servers are live (browser-default, drill, kanban-loop, web-channel-default).
- **Live job state.** `~/.garrison/scheduler-jobs.json` carries `last_run` stamps. `kanban-tick` last fired `2026-07-20T11:58:03Z`.
- **Caller-chain grep.** Every timer traced back to a `scripts/start.mjs`/`server.mjs` listen path, an entry in `compositions/default/apm.yml`, or nothing.

`crontab -l` -> "no crontab for ggomes". No launchd (Linux host).

### 1.2 Tier 1 - the cron engine

| # | What | Where | Cadence | Config? | Status |
|---|---|---|---|---|---|
| 1 | Scheduler daemon tick loop | `fittings/seed/scheduler/scripts/scheduler.mjs:338` (`while (!shuttingDown)` in `daemon()` @ `:288`, sleep at `:349`) | `TICK_INTERVAL_MS = 60_000` @ `:43` | **Hardcoded** - no env, no flag | **ACTIVE** (2 live PIDs) |
| 2 | Listener respawn backoff | `scheduler.mjs:236` in `spawnListener()` @ `:212`, driven by `superviseListeners()` @ `:255` | exponential from 1000ms, cap 60s (`:212`, `:238`) | Hardcoded | **ACTIVE path, idle** - no `type: listener` job exists today |
| 3 | Scheduler health server | `scheduler.mjs:265` `startHealthServer()`, bound `:329` | n/a | `--health-port` / `GARRISON_SCHEDULER_HEALTH_PORT` / composition `health_port`; default 27099 @ `:47` | **ACTIVE** |

Started by `scripts/garrison-instance.sh:187` (builds `scheduler_cmd`) under `concurrently` at `:201-224`. Reached from `package.json` `dev` / `start` / `prod:start` / `codex:start`.

Job execution is `spawn("/bin/sh", ["-c", job.command])` at `scheduler.mjs:150` - deliberately shell-evaluated, same trust model as a user crontab.

### 1.3 Tier 2 - registered cron jobs (the actual recurring work)

From the **live** `~/.garrison/scheduler-jobs.json`:

| Job id | Cron | Command | Cadence source | Status |
|---|---|---|---|---|
| `kanban-tick` | `*/2 * * * *` | `kanban.mjs --tick` | `fittings/seed/kanban-loop/scripts/kanban.mjs:280`, env `KANBAN_TICK_CRON` | **ACTIVE - fired today 11:58** |
| `improver-nightly` | `30 3 * * *` | `improver.mjs run-now improver-nightly` | `compositions/default/apm.yml:134` -> `fittings/seed/improver/scripts/setup.sh:63` | Enabled; **no `last_run` key** |
| `kanban-test-beat` | `0 */5 * * *` | `kanban.mjs --tick-list test` | `fittings/seed/kanban-loop/lib/scheduler-beats.mjs:14` (`DEFAULT_TEST_CRON`), env `KANBAN_TEST_BEAT_CRON` | Enabled; no `last_run` |
| `vault-git-sync` | `0 4 * * *` | `vault-git-sync/scripts/sync.sh` | `compositions/default/apm.yml:167` -> `fittings/seed/vault-git-sync/scripts/setup.sh` | Enabled; no `last_run` |

**Noted, not fixed:**
- `data/scheduler-jobs.json` (committed) holds **only** `improver-nightly` and is a stale seed copy. The daemon reads `GARRISON_SCHEDULER_JOBS` set at `scripts/garrison-instance.sh:108`, pointing at `~/.garrison/`. Anyone reading the repo file will draw the wrong conclusion about what runs.
- All four commands point at `compositions/default/apm_modules/_local/...` - the **installed copies**, not `fittings/seed/`. Edits to seed sources do not reach cron until re-install. `scripts/repoint-scheduler-jobs.mjs` exists to repair these paths across checkouts.
- `docs/DECISIONS.md:493` records that `improver-nightly` "has never once completed real work" despite firing - consistent with the absent `last_run`.

**Beat registration machinery (ACTIVE):** `fittings/seed/kanban-loop/lib/scheduler-beats.mjs:44` (`syncListBeat`) / `:72` (`syncAllBeats`), called from `kanban.mjs:269` at setup and from `PATCH /lists/:id` in the board server. Shells out to `scheduler.mjs remove` + `add` (`:54`, `:62`). This is the code path that wrote `kanban-test-beat`.

### 1.4 Tier 3 - systemd timers

| # | Unit | Source | Cadence | Config? | Status |
|---|---|---|---|---|---|
| 4 | `garrison-snapshots.timer` | `fittings/seed/snapshots-default/systemd/garrison-snapshots.timer:5` | `OnCalendar=*-*-* 03:00:00`, `Persistent=true` | **Hardcoded** in the unit | **ACTIVE** - last ran 2026-07-20 03:00:56 |
| 5 | `garrison-snapshots-prune.timer` | `.../garrison-snapshots-prune.timer:5` | `OnCalendar=Sun *-*-* 03:30:00` | **Hardcoded** | **ACTIVE** - last ran 2026-07-19 03:30 |
| 6 | `garrison-scheduler.service` | `fittings/seed/scheduler/launchers/systemd/garrison-scheduler.service` | n/a | n/a | **DEAD on this host** - `is-enabled` -> disabled, `is-active` -> inactive; its `ExecStart` targets `/home/ggomes/dev/garrison-codex/...`, a different checkout |
| 7 | launchd plist | `fittings/seed/scheduler/launchers/launchd/io.garrison.scheduler.plist` | n/a | n/a | **DEAD** - macOS template, wrong platform. Same for `launchers/docker/Dockerfile` and `launchers/pm2/ecosystem.config.cjs` |

**Noted, not fixed:** `garrison-scheduler.service` is disabled today, but if it were ever enabled it would be a second daemon over the same shared jobs file - see the race in §1.9.

### 1.5 Tier 4 - fitting server-side timers

| # | Where | Cadence | Config? | What it does |
|---|---|---|---|---|
| 8 | `fittings/seed/drill/scripts/server.mjs:1836` (`.unref()`'d at `:1839`) -> `runHeartbeatSweep` in `fittings/seed/drill/lib/heartbeat.mjs:20` | 60s | `DRILL_HEARTBEAT_INTERVAL_MS` | Auto-dispatches drill runs with `dispatch === "heartbeat"` into kanban fix cards. **ACTIVE / RUNNING** (PID 3142395). Despite the name, this is *not* the Kanban heartbeat. |
| 9 | `fittings/seed/kanban-loop/scripts/server.mjs:1832` | 1000ms | Hardcoded | Per-SSE run-log pump; self-terminates when the card leaves `running`. **RUNNING** |
| 10 | `fittings/seed/dev-env/scripts/server.mjs:1269` | 5000ms | Hardcoded | Demotes sessions stuck "working" back to idle |
| 11-13 | `fittings/seed/browser-default/scripts/server.mjs:1036` (capture reaper), `:1642` (`setupHeartbeat`, 15s WS ping), `:2094` (`startFocusWatcher`, ~250ms); `scripts/spotter.mjs:426` | mixed | Hardcoded | **RUNNING** (PID 3142382) |
| 14-15 | `fittings/seed/monitor-default/scripts/server.mjs:572` (`pollHandle`), `:574` (cleanup, hourly) | `MONITOR_POLL_MS` / composition `poll_interval_ms: 1000`; cleanup hardcoded 1h | Poll **configurable**, cleanup hardcoded | Log tail + retention prune |
| 16 | `fittings/seed/ports-default/scripts/server.mjs:421` | composition `scan_interval_ms: 5000`, floor 500 @ `:56` | **Configurable** | Port scan |
| 17 | `fittings/seed/power-default/scripts/server.mjs:784` | `TICK_MS` | Hardcoded const | Idle/load watchdog |
| 18 | `fittings/seed/screen-share-default/scripts/server.mjs:128` in `startCapture()` @ `:122` | `SCREEN_SHARE_INTERVAL_MS \|\| 1000` @ `:40` | **Env-overridable** | Frame capture |
| 19-22 | `fittings/seed/http-gateway/scripts/gateway.mjs:742`, `:855` (SSE heartbeats); `gateway-pty.mjs:1626` (700ms pump), `:1681`; `scripts/lib/jsonl-watcher.mjs:49` (`POLL_MS = 1000` @ `:15`); `scripts/lib/ask-question.mjs:117` (`intervalMs = 400`) | mixed | Mostly hardcoded | Transcript tail, PTY pump, SSE keepalive |
| 23 | `fittings/seed/loop-heartbeat/scripts/heartbeat.mjs:69` (`while (true)` in `daemon()` @ `:58`, sleep `:70`) | `GARRISON_HEARTBEAT_MINUTES ?? 40` @ `:13` | **Env-overridable** | POSTs a synthetic "heartbeat-tick" to the gateway telling the operative to suggest Trello tasks in Slack. **DEAD in the default composition** - `loop-heartbeat` is not in `compositions/default/apm.yml`; it appears only in `compositions/dogfood-orch/apm.yml:11,39`. No process runs it, no scheduler job invokes it, `garrison-instance.sh` never starts it. Its `--probe`/`--once` CLI paths remain manually reachable. |

### 1.6 Tier 5 - packages/

| # | Where | Cadence | Config? |
|---|---|---|---|
| 24 | `packages/claude-pty/src/session-manager.mjs:98` (`sweepIdle`) | `opts.sweepIntervalMs ?? 5min` @ `:14`; idle threshold `?? 1h` @ `:13` | Constructor-injected |
| 25 | `packages/claude-pty/src/warm-pool.mjs:159` | `Math.min(idleTimeoutMs, 60_000)`; `idleTimeoutMs` default 30min @ `:11` | Constructor-injected |
| 26-29 | `src/rich-stream.mjs:87,95`; `src/screen.mjs:327`; `src/readiness.mjs:72`; `src/detection.mjs:124` (250ms), `:193` (500ms) | short | Bounded/cleared on resolution, not perpetual |
| 30 | `packages/claude-chat/src/ClaudeChat.tsx:566` (15s probe), `:582` (1s ticker) | Hardcoded | UI |

### 1.7 Tier 6 - UI polling

All `useEffect` intervals, active while mounted, **hardcoded literals unless noted**.

Next.js app: `src/components/garrison/GarrisonHome.tsx:272` (30s board summary), `src/components/chrome/AppShell.tsx:120` (60s presence beat) and `:267` (5s runner state, **skipped while tab hidden**), `src/components/chrome/Sidebar.tsx:83` (1s clock), `src/components/coordination/CoordinationPanel.tsx:137` (15s), `src/components/fitting-views/useFittingViewStatus.ts:61` (**`pollMs = 15000` caller-overridable, `<= 0` disables** @ `:60`), `src/components/fitting-views/FittingOverview.tsx:546` (1500ms), `src/components/settings/SettingsPanel.tsx:167` (drift poll, **triple-guarded**: skips if hidden, if saving, or if edits pending), `src/components/tours/TourEngine.tsx:253` (`POLL_MS = 250` @ `:36` plus a rAF loop @ `:173`), `src/app/api/runner/[id]/logs/route.ts:20` (15s SSE keepalive).

Fitting-owned UIs: `kanban-loop/ui/main.tsx:136` (1s), `:940` (3s board pull), `:1703` (5s); `drill/ui/main.tsx:444,1127,1209,1416,2154`; `dev-env/ui/main.tsx:724,974,991` plus `browser-pane.tsx:247`, `terminal-pane.tsx:173`; `web-channel-default/ui/main.tsx:437,634`, `voice-conversation.tsx:78`, `legacy-voice.tsx:413` (**likely dead** - file named "legacy"); `browser-default/ui/main.tsx:51,557`; `screen-share-default/ui/main.tsx:29` and `:35` (**server-driven** `state.intervalMs`); `ports-default/ui/main.tsx:74`; `outpost-tailscale-host/ui/main.tsx:425`; `vault-sync/ui/VaultSyncStatus.tsx:41` (30s - **note the fitting is `vault-sync` but the default composition installs `vault-git-sync`; likely dead here**).

### 1.8 Checked and excluded (not recurring)

`scripts/probe-*.mjs`, `scripts/matrix-harness.mjs:363`, `scripts/lib/mcp-stdio-client.mjs:72,117`, `scripts/outpost-host.mjs:291,574,874` - one-shot hard-timeout guards. `fittings/seed/codex-runtime/scripts/bridge.mjs:116,122` - bounded result-wait. `fittings/seed/kanban-loop/scripts/kanban.mjs:438` - 1500ms `AbortController`. Everything under `tests/` - fixture keep-alives.

`fittings/seed/morning-briefing/` has cron *translation* logic (tested by `tests/morning-briefing-cron-translation.test.ts`) and registers job id `morning-briefing` at `scripts/setup.sh:47`, but it is **not in any composition's selections and not in the live jobs file**. Dead today.

### 1.9 Issues found in the inventory (noted, not fixed)

1. **Two scheduler daemons run simultaneously** (prod 8099, codex 27999) and **both read the same machine-global `~/.garrison/scheduler-jobs.json`**. The only thing preventing double-firing is the `minuteKey` / `last_run_minute` field at `scheduler.mjs:123` - a read-modify-write on a shared file with **no locking**. This is the same class of race `docs/DECISIONS.md:539` already documents for `review-queue.json`.
2. `data/scheduler-jobs.json` in the repo is stale and misleading (§1.3).
3. `garrison-scheduler.service` on disk points at a different checkout (`~/dev/garrison-codex`); harmless while disabled, a duplicate-firing hazard if enabled.
4. `compositions/default/.claude/skills/scheduler/SKILL.md:112-127` is stale - it claims "the runner does not auto-spawn the scheduler daemon", but `garrison-instance.sh:187` does. Its `:17-21` also claims the jobs default is composition-relative `data/scheduler-jobs.json`, contradicting `apm.yml:17`.
5. The live codex daemon runs on `--health-port 27999`, not the 27099 the profile table in `src/lib/instance-profile.ts:29-42` predicts.

---

## 2. The Kanban Loop heartbeat, in detail

**Terminology warning.** Nothing in the code is named `heartbeat`. The codebase calls the global cadence **the tick** and explicitly contrasts it with per-list **scheduler beats** (`fittings/seed/kanban-loop/scripts/kanban.mjs:127-130`, `lib/engine.mjs:2247`, `apm.yml:53`). The word "heartbeat" appears in two unrelated places: `fittings/seed/drill/lib/heartbeat.mjs` (the drill sweep, §1.5 #8) and the prose stub `compositions/dogfood-orch/.claude/rules/loop-heartbeat.md`. Do not conflate them.

### 2.1 Trigger and cadence

There are **three** drivers, not one.

**(a) The global tick** - `async function tick()` at `scripts/kanban.mjs:449`, CLI `--tick` at `:559`.
Registered as an external cron job by `registerTick()` at `:279-296`, which shells out to the sibling scheduler CLI (`schedulerCli()` @ `:262-265`) removing then re-adding job id `kanban-tick` with command `node <this file> --tick`. Called from `setup()` @ `:330`.
**Cadence `*/2 * * * *`, configurable via `KANBAN_TICK_CRON`** (`:280`). The default lives inline - **it has no `config_schema` entry in `apm.yml`**, unlike the far less central `test_beat_cron`.

**(b) Per-list scheduler beats** - `--tick-list <id>` -> `tickList(listId)` at `:501`.
Registered by `syncAllBeats`/`syncListBeat` in `lib/scheduler-beats.mjs:44-80`, from `registerSchedulerBeats()` @ `kanban.mjs:270-273` and from `PATCH /lists/:id` so a UI cron edit takes effect immediately. Beat id `kanban-<listId>-beat` (`scheduler-beats.mjs:27-29`).
Cadence resolution `cronForList` (`:34-39`): the list's own `beatCron`, else the legacy Test default `0 */5 * * *` (`KANBAN_TEST_BEAT_CRON`, `:14`), else **not registered at all**. `syncListBeat` always `remove`s first (`:54`) so flipping a trigger to `manual` unregisters cleanly.

**(c) `processChain`** - `lib/engine.mjs:1910-1929`, fire-and-forget from the board server on a card move (`scripts/server.mjs:1350`, `:1709`, `:1754`). Walks a card through consecutive *immediate* lists without waiting for the next tick, capped at 50 hops (`engine.mjs:1913`).

### 2.2 What it sweeps, in what order

The tick **iterates cards, not lists**. `loadAllCards(root)` (`kanban.mjs:463` -> `lib/board.mjs:380-391`) does an `fs.readdir` of `<root>/cards` with **no explicit sort** - directory order. Since ids are ULIDs this is roughly creation order in practice, but it is not guaranteed and there is no ordering by list or priority.

Per-card filters, in order (`kanban.mjs:477-490`):
1. `isGatedDiscuss(card, list) && card.discussHeld !== true` - escape hatch for clarity-gated Discuss cards (`:477`)
2. `list.kind !== "agent"` -> skip (manual + agent-interactive) (`:479`)
3. `triggerFor(list) !== "immediate"` -> skip (**so Test never runs on the global tick**) (`:480`)
4. `isInteractive(list)` -> skip (`:481`)
5. `status === "running" || "needs-attention"` -> skip (`:483`)
6. `card.waitingOn` -> skip (`:484`)
7. degraded-coordination `serializeGate` (`:487-490`)

Before any dispatch the tick calls `reevaluateWaiting({root, board, cards})` and then **re-reads all cards**, so a card released this tick is seen on its new list in the same pass (`:461-463`).

Default board sweep set (`kanban.mjs:76-186`): immediate agent lists `plan, implement, review, adversarial-review, adversarial-test, walkthrough, validate`; `test` is scheduler-beat; `backlog, todo, done, needs-attention` are manual; `discuss` is agent-interactive.

### 2.3 Grouping and batching

Batching exists **only** for lists flagged `batched: true` - today only Test (`kanban.mjs:131`) - and only via the `--tick-list` path (`:522-532`).

- **Primary grouping is per PROJECT** (not per repo directly - `project` doubles as the repo handle): `groupCardsByProject(cards, listId)` at `lib/engine.mjs:2254-2264`. Keys on `c.project`, buckets null under the literal `"(no-project)"` (`:2260`), reapplies the same eligibility filters as the tick (`:2257-2259`).
- **Secondary sub-grouping by resolved execution cell:** `processBatch` splits each project group again so cards only share a session when their resolved v4 step matches exactly - `engine.mjs:2340-2362`, keying on `JSON.stringify({targetId, runtime, provider, model, effort, params})`, legacy cards under `"legacy"` (`:2345-2354`).
- **Batch prompt:** `batchGatewayRunFn` at `kanban.mjs:357-424` - a roster line per card (`id :: title / runDir / sliceId / next-options`, `:398-401`), prepended by the list mode and `executePrompt`, demanding `` `<cardId> <next-list>` `` per line (`:406-415`).
- **Verdict parsing:** `parseBatchVerdicts` at `engine.mjs:2294-2313` - strips `[...]` gateway badges (`:2296`), takes the **last** occurrence of each card id (`:2306`), then the first whole-word valid-next token via `firstValidNextIn` (`:2275-2283`), exact-matched against that card's own `validNextForCard` (`:2304`).

### 2.4 State transitions and where the logic lives

**Transition logic is not centralized.** It is duplicated across three seams that deliberately mirror each other:

1. `processCard` - `engine.mjs:894-1866` (per-card dispatched path)
2. `processBatch` - `engine.mjs:2321-2806` (batched path; its own comments repeatedly say "mirror of processCard", e.g. `:2589`, `:2624`)
3. `advanceCardPhase` - `engine.mjs:1942+` (in-process "garrison doorway", D13; header at `:1931-1941` states it enforces "the SAME contract")

Shared helpers keep them honest: `parkFields` (`:514`), `withEvent` (`:460`), `effectiveListForCard` (`:420`), `evidenceContractForTransition` (`:227`), `gateContractForTransition` (`:243`), `validNextForCard` (from `lib/resolved-model.mjs`).

Transitions applied in `processCard`, in evaluation order:
- **Rail fast-forward on entry** - a phase OFF for the card's rail advances without dispatching, emitting `phase-off` events (`:985-1029`); an OFF Test fast-forwarding to Done still requires `evidence.md` (`:1000-1020`)
- **Iteration-cap park** (`:939-954`)
- **Lease wait** -> `waitingOn {until:"lease"}` (`:1035-1072`)
- **Outpost affinity offline -> park** (`:1076-1110`)
- **Acquire** - CAS write of `status:"running"`, `iterations`, `runningSince`, dispatch event (`:1114-1144`)
- **Verdict ladder** - `parseNextList` (`:1375`) -> durable gate verdict `gateEvidenceNextList` (`:1396`) -> empty-reply grace poll (`:1402-1408`) -> a single LLM nudge turn (`:1416-1441`)
- **Rail resolution** of the named next into `checkedNext` (`:1445-1448`)
- **Four integrity gates that null the verdict** (`:1489`): `evidenceMissing` (`:1452-1457`), `gateEvidenceStale`, `gateEvidenceMissing`, `gateVerdictMismatch` (`:1463-1488`), plus a fail-safe park when the policy file is corrupt (`:1471-1473`)
- **Discuss explicit-gate hold** -> `discussHeld: true`, no advance (`:1510-1531`)
- **Advance / coordination outcomes** - park (`:1595`), wait (`:1611`), interference-wait (`:1627`), genuine advance (`:1644-1703`; commits a fence, renews/releases leases, writes the `routed` event, sets `list: effectiveNext`)
- **Park branches** - stale gate (`:1704`), missing gate (`:1720`), mismatched gate (`:1736`), missing evidence (`:1753`), empty reply (`:1770`), no exact match (`:1797`)

### 2.5 How results are written back

- **Cards:** `<root>/cards/<ULID>/card.json` (`lib/board.mjs:65`), always via `saveCardCAS` (`:311-341`) or `updateCardCAS` (`:354`), temp-file+rename (`atomicWriteJSON`, `:23`). Root = `$GARRISON_KANBAN_DIR` else `$GARRISON_HOME/kanban-loop` else `~/.garrison/kanban-loop` (`:16-19`).
- **Board:** `<root>/board.json` (`:61-63`), CAS via `saveBoardCAS`/`withBoardLock` (`:277-301`).
- **Per-iteration logs:** `<root>/cards/<id>/log-<n>.md` - `writeCardLog` at dispatch (`engine.mjs:1175`), streamed appends, authoritative overwrite with the final reply (`:1368`). Tail via `readLogTail` (`:150-153`).
- **Run artifacts / evidence:** run dir minted once per card by `mintRunFields` (`engine.mjs:400-410`) as absolute `~/.garrison/runs/<projectLabel>/<runId>` (`RUNS_HOME` `:349-352`, override `GARRISON_RUNS_DIR`). Gate records `<runDir>/gate-status.<phase>.json`, evidence `<runDir>/evidence/` (`kanban.mjs:141-142`, `:159-163`; checks `engine.mjs:190-215`).
- **Duty rollups:** `writeDutySummary` under the run dir on every genuine advance (`engine.mjs:1818-1829`, defined `:788`).
- **Handoff:** `cards/<id>/handoff.json` generated on the done edge inside `saveCardCAS`.
- **Git:** indirectly - `commitFence` from `lib/fences.mjs` on each advance when coordination fences are enabled (`engine.mjs:1652-1656`; batch `:2702-2707`), recording a sha onto `card.fences`.
- **stdout:** one line per card plus a summary (`kanban.mjs:492`, `:495`, `:528-530`).

### 2.6 Failure handling

- **Retry ceiling:** per-card iteration cap, default 10, from `GARRISON_KANBAN_ITERATION_CAP` (`kanban.mjs:457`, `:514`; `apm.yml` `iteration_cap`). Enforced `engine.mjs:939-954` (per-card), `:2381-2390` (batch). Breach parks in `needs-attention`.
- **Iteration refund:** foreign-breakage interference refunds the consumed iteration (`engine.mjs:1581`, `:1662`).
- **Transport failures do not park:** `err.transport` reverts the acquire, stamps `lastDispatchError.reason = "gateway-unavailable"`, emits `deferred`, leaves the card in place (`engine.mjs:1252-1280`; batch `:2446-2475`). Non-transport errors park (`:1282-1302`, `:2477-2489`).
- **Pre-flight skip:** `gatewayReachable()` pings with a 1.5s abort and skips the whole tick when the gateway is down rather than parking every card (`kanban.mjs:435-445`, called `:451`, `:503`).
- **Empty-output grace window:** `pollForGateEvidence` (`engine.mjs:137-149`) polls the gate file for `GARRISON_EMPTY_GATE_GRACE_CHECKS` x `GARRISON_EMPTY_GATE_GRACE_INTERVAL_MS`, default **24 x 30s ~= 12 min** (`:121-122`). Only then parks, with `retryKeepsContext: true` (`:1770-1796`).
- **Verdict nudge:** exactly one bounded follow-up turn that does *not* consume an iteration (`:1376-1441`; batch `:2542-2572`).
- **Max-turn stop:** `stoppedReason === "max_turns"` is terminal - no nudge, rescuable only by an already-written gate (`:1332`, `:1353-1365`, `:1369-1371`; batch `:2493`, `:2513-2541`).
- **Stale-reply echo detection:** a reply whose `[route: ...]` token disagrees with the resolved target is treated as transport and retried (`:1236-1241`).
- **Stuck-run detection:** `recoverInterruptedRuns` (`engine.mjs:1881-1908`) sweeps at board-server boot (`server.mjs:2328`), clearing cards left `running` by a crash, keeping the consumed iteration, setting `lastDispatchError.reason = "interrupted"`. **This is boot-only. There is no time-based stall sweep** - a card whose owning process is alive but hung stays `running` indefinitely; only the UI's `Elapsed since={card.runningSince}` counter (`ui/main.tsx:327`) surfaces it. Directly relevant to the stalled-card gap in §6.
- **Error states:** `status: "needs-attention"` + `parkFields` (`engine.mjs:514-527`), `eventKind` `"failed"` (dispatch error / cap / empty) vs `"blocked"`. Un-parking via board PATCH clears these and resets iterations (`:512-513`).

### 2.7 Concurrency

- **The tick is fully serial** - `for ... of cards` with `await processCard(...)` (`kanban.mjs:470-494`); same in `tickList`'s non-batched path (`:537-548`). Batch is serial across groups too (`engine.mjs:2370-2445`).
- **The real anti-double-dispatch primitive is CAS-under-file-lock.** `saveCardCAS` runs read -> compare `rev` -> write inside `withCardLock` (an `O_EXCL` lock at `cards/<id>/.lock`), so two concurrent ticks cannot both observe the same rev and both succeed - `lib/board.mjs:304-341`, lock `:270-274`. Acquire writes `status:"running"` with `baseRev` (`engine.mjs:1114-1144`); the loser gets `{status:"skipped", reason:"conflict"}` (`:1144`) or `{status:"needs-attention", reason:"conflict-during-run"}` (`:1815`).
- Status guards (`kanban.mjs:483`, `:539`, `engine.mjs:2258`) are the cheap first line; CAS is the correctness line.
- Board writes serialized by `withBoardLock` + `saveBoardCAS` (`board.mjs:277-301`).
- **Engine-header suppression:** an `x-garrison-engine` PATCH must not fire a background `processChain` alongside the in-session `advanceCardPhase` driver (`server.mjs:1300-1322`, `callerOwnsProgression` @ `:1319`).
- **Discuss hold:** `discussHeld === true` blocks re-dispatch at the single seam `engine.mjs:915-917` plus the tick's own check `kanban.mjs:477`.
- **`waitingOn` guard** checked three times (`kanban.mjs:484`, `server.mjs:1329`, `engine.mjs:923-925`).
- **Degraded-coordination serialization:** `serializeGate(cards, card, board)` allows only the oldest live card per project (`kanban.mjs:464-465`, `:487-490`; `server.mjs:1337-1344`).
- **Exclusive leases** gate Implement dispatch *before* the acquire so a blocked card never burns an iteration (`engine.mjs:1035-1072`).

---

## 3. Task and card data model

### 3.1 Where the schema lives

There is **no formal schema** - no zod, no JSON Schema, no typedef. The object literal in `createCard` at `fittings/seed/kanban-loop/lib/board.mjs:94-184` **is** the schema. The TS interfaces in `fittings/seed/kanban-loop/ui/api.ts` describe the *projected wire shape* (`CardSummary`), not the on-disk card. `src/lib/kanban-model.ts` is the composition->board *pipeline* projection, not the card schema.

Verified against 40 live cards on disk: the key union matches, plus `attentionKind`, `retryKeepsContext`, `quick`, `inferState` added post-creation.

### 3.2 Card fields

**Identity and core** (`board.mjs:76-183`)

| Field | Type | Meaning | Line |
|---|---|---|---|
| `id` | ULID (26 char) | Card id; also the directory name | `:76` |
| `title` | string | Defaults `"(untitled)"` | `:96` |
| `description` | string | Free text; feeds project inference | `:97` |
| `project` | string \| null | Project/repo slug **or absolute workspace path** | `:98` |
| `list` | string | Current list id - **the state field** | `:99` |
| `status` | string | `ok` \| `running` \| `needs-attention` | `:100` |
| `iterations` | int | Convergence-cap counter; **resets** on human retry | `:101` |
| `rev` | int | CAS token | `:102` |
| `cost` | number \| null | Accumulated run cost | `:103` |
| `goalMode` | bool | Goal-loop flag | `:104` |
| `acceptance` | any \| null | Acceptance criteria payload | `:105` |
| `created` / `updated` | ISO | `updated` bumped by every save | `:182-183` |

**Run-policy / rail** (D2/D8/D17)

| Field | Type | Meaning | Line |
|---|---|---|---|
| `workKind` | string \| null | **Names the policy work kind whose phase plan is this card's rail** | `:111` |
| `phases` | `Record<string,bool>` \| null | Per-card phase toggles merged OVER the plan; `false` = OFF (dimmed, never hidden) | `:112` |
| `tier` | string \| null | Rides classification | `:113` |
| `origin` | string \| null | Who registered the run; auto-set `"continuation"` | `:114` |
| `origin_id` | string | `web:<threadId>` \| `skill:unknown` \| `board`; derived by `lib/origins.mjs:deriveOriginId` | `:188-189` |
| `originChannel` | `{channel,threadId}` \| null | Thread to post the outcome back to | `:121-124` |
| `continues` | ULID \| null | Predecessor card (WS2/D7); regex-validated `:79` | `:117` |
| `outpost` | string \| null | D27 single-outpost affinity; offline -> needs-attention | `:140` |

**Resolved-model journey** (D15/S4a)

| Field | Type | Meaning | Line |
|---|---|---|---|
| `duty` | string \| null | Duty this card executes | `:131` |
| `level` | int \| null | Duty level | `:132` |
| `sequence` | string[] \| null | **Cached ordered leaf phase-list ids this card visits.** Null -> engine falls back to the board's static `validNext` | `:133` |
| `clarity` | `"needs-discuss"` \| null | Dispatcher spec-clarity verdict; gates the Discuss detour | `:137` |

A continuation **inherits** `duty`/`level`/`sequence` from its predecessor when unspecified (`:84-93`).

**Execution visibility**

| Field | Type | Meaning | Line |
|---|---|---|---|
| `events` | `CardEvent[]` | Timeline, appended by `withEvent` on every transition; seeded with a `created` event | `:146` |
| `lastReply` | string \| null | Last operative reply snippet | `:147` |
| `runningSince` | ISO \| null | Drives the live elapsed timer | `:148` |
| `logIndex` | int | **Monotonic** high-water mark for `log-N.md`; unlike `iterations`, never resets | `:152` |

`CardEvent` = `{at, kind, message, detail?, route?}` (`ui/api.ts:32-38`). `kind` in: created, moved, recovered, dispatch, routed, parked, deferred, failed, inference, steering-restage, phase-off, coordination, retry-keeps-context, blocked. `route` is a `RouteStamp` (`ui/api.ts:15-26`).

**Pointer fields** (V1b FINDING 10 - the card stores pointers, never document bodies)

| Field | Meaning | Line |
|---|---|---|
| `runId` | Minted **lazily on first agent-list entry** | `:158` |
| `runDir` | Run directory | `:159` |
| `sliceId` | FLOW_PLAN slice being built | `:160` |
| `sessionIds` | Claude Code transcript ids | `:161` |
| `briefPath` | Relative `cards/<id>/brief.md` marker; helpers `:72-73` | `:162` |
| `videoUrl` | Walkthrough gallery link | `:163` |

**Coordination** (GARRISON-FLOW-V2 S1/S2)

| Field | Meaning | Line |
|---|---|---|
| `waitingOn` | Wait descriptor `{cardId,cardTitle,grade,reason,until,thenTo,rerun,since}` (`ui/api.ts:43-52`) | `:173` |
| `stabilityAt` | First-review stability point | `:174` |
| `planCompletedAt` | **Total-order key** for ordering overlapping runs | `:175` |
| `blocking` | Best-effort list of cards waiting on this one | `:176` |
| `fences` | `{phase,sha,at,empty}[]` git commit anchors | `:180` |
| `preparedRevert` | Post-abandonment revert descriptor (`ui/api.ts:71-77`) | `:181` |

**Added post-creation** (not in the constructor, live on disk)

| Field | Meaning | Where |
|---|---|---|
| `parkedFrom` | List parked from | `engine.mjs:518` |
| `attentionReason` | Why it parked | `engine.mjs:519` |
| `attentionKind` | Lifecycle kind routed on the park | `engine.mjs:520-521` |
| `retryKeepsContext` | Retry preserves prior runDir + logs | `server.mjs:1192-1194` |
| `quick` | D19 - gateway ran it inline, auto-advanced to Done; **never engine-owned** | `server.mjs:1044-1045`, `:190` |
| `inferState` | `running\|done\|none\|skipped\|failed` project-inference state | `server.mjs:941,948,960-967` |
| `steeringPending` | **Projection only** - computed from disk `server.mjs:863-873`, never stored | - |

### 3.3 Kanban states (lists)

Two sources, resolved at seed time by `resolveSeedBoard()` (`kanban.mjs:221-225`): if `~/.garrison/kanban-loop/model.json` exists -> `buildBoard(model)`; else the hardcoded default.

**Hardcoded default pipeline** - `kanban.mjs:73-187` (`seedBoard`), 13 lists, `version: 3`:

| order | id | kind | trigger | phase | validNext | line |
|---|---|---|---|---|---|---|
| 0 | `backlog` | manual | manual | - | `[todo]` | `:78-83` |
| 1 | `todo` | manual | manual | - | `[discuss, plan]` | `:84` |
| 2 | `discuss` | **agent-interactive** | manual | - | `[plan]` | `:85-93` |
| 3 | `plan` | agent | immediate | plan | `[implement]` | `:99-105` |
| 4 | `implement` | agent | immediate | implement | `[review]` | `:106-112` |
| 5 | `review` | agent | immediate | review | `[adversarial-review, implement]` | `:113-118` |
| 6 | `adversarial-review` | agent | immediate | adversarial-review | `[test, implement]` | `:119-124` |
| 7 | `test` | agent | **scheduler-beat** | test | `[adversarial-test, implement]` | `:125-146` |
| 8 | `adversarial-test` | agent | immediate | adversarial-test | `[walkthrough, implement]` | `:147-152` |
| 9 | `walkthrough` | agent | immediate | walkthrough | `[validate, implement]` | `:153-166` |
| 10 | `validate` | agent | immediate | validate | `[done, implement]` | `:167-175` |
| 11 | `done` | manual | manual | - | `[]`, `terminal: true` | `:176` |
| 12 | `needs-attention` | manual | manual | - | `[todo, plan, implement]`, `notifyOnEntry` | `:177-183` |

Plus `projects: {}` at `:185`.

**Per-list config surface** - `ui/api.ts:209-226` (`ListConfig`): `id, title, order, kind, trigger, beatCron, interactive, terminal, phase, executePrompt, routerPrompt, validNext`.

Notable seed config: `backlog.onEnter: "infer-title-and-project"` (`:81`); `discuss.interactive: true, surface: "web-channel", onEnter: "open-web-chat"` (`:90-91`); `test.beatCron: "0 */5 * * *"`, `batched: true`, `requiresEvidenceOn: ["done"]`, `requiredEvidenceFile: "evidence.md"` (`:130-138`); `walkthrough.requiresEvidence: true` (`:157`); `needs-attention.notifyOnEntry: true` (`:181`).

**Engines/skills bound to a list: explicitly NO.** `kanban.mjs:94-98`: "a list maps to a PHASE NAME and nothing else (D15): skill / model / effort / runtime resolve from the compiled Orchestrator policy at dispatch time." The v2 per-list `skill`/`taskType`/`tier`/`mode` pins are **stripped by migration** at `board.mjs:42-44`. Resolution goes through `lib/policy.mjs` - `railForCard(policy, card)` at `:92-98` reads `card.workKind || policy.defaultWorkKind` -> `policy.workKinds[kind].phasePlan` -> `policy.phasePlans[...]`.

**Engine-owned list fields** (not operator-editable) - `lib/resolved-model.mjs:186-202` (`ENGINE_OWNED_LIST_FIELDS`): `id, order, kind, phase, validNext, interactive, surface, terminal, onEnter, notifyOnEntry, batched, requiresEvidence, requiresEvidenceOn, requiredEvidenceFile`. Title, trigger, beatCron and prompts are operator config, preserved across reconcile.

**Dynamic list generation** - `buildBoard(model, opts)` at `resolved-model.mjs:315-380`. Fixed human head `["backlog","todo"]` (`:31`) + optional `discuss` detour + one phase list per leaf duty in `model.kanbanLists` + fixed tail `["done","needs-attention"]` (`:32`). `discuss` is deliberately pulled out of the forward-edge chain (`:325-330`). `GATE_PHASES` (`:38-45`) = `review, adversarial-review, test, adversarial-test, walkthrough, validate` - the phases whose fail edge loops back to `implement`.

### 3.4 Persistence

Layout documented at `lib/board.mjs:1-6`:

```
<root>/
  board.json          list defs + order + per-list config (NEVER membership)
  model.json          projected resolved model (written by src/lib/kanban-model.ts)
  origins/            durable per-origin event logs
  cards/<ULID>/
    card.json         the card
    brief.md          card-owned Discuss brief
    handoff.json      WS2 handoff packet (written on the done edge)
    log-1.md, ...     per-session logs
    .lock             per-card O_EXCL lock
  .board.lock         board-level lock
```

**One directory per card**, JSON, 2-space pretty-printed (`board.mjs:26`).

Root resolution (`board.mjs:16-19`): `GARRISON_KANBAN_DIR` else `$GARRISON_HOME/kanban-loop` else `~/.garrison/kanban-loop`. There is **no hardcoded `~/.garrison-dev`** - dev isolation is purely via `GARRISON_HOME` (`src/instrumentation.ts:17`, `src/app/api/snapshots/core.ts:20-22`; TS mirror `src/lib/claude-home.ts:37-40`, `src/lib/board-summary.ts:40`). Verified live: `~/.garrison/kanban-loop/{board.json,cards,model.json,origins}` exists; `~/.garrison-dev` does not.

**Critical invariant: list membership is DERIVED, never stored** (`board.mjs:5`, `deriveMembership` `:393-400`) - membership comes from scanning `cards/*/card.json` and reading `card.list`. `board.json` never holds card ids. This is why a board rebuild touches no card state.

Concurrency: atomic temp+rename with unique temp names (`:23-28`, `:447-465`); per-card `O_EXCL` lock with owner-pid liveness probe (`:212-282`); CAS on `rev` (`saveCardCAS` `:311-343`, `saveBoardCAS` `:288-302`, `updateCardCAS` `:354-369`).

### 3.5 Does any field distinguish card TYPE or PROJECT?

| Term asked about | Exists? | Detail |
|---|---|---|
| `project` | **YES** | `board.mjs:98`. String\|null. A kebab-case slug matching `/^[a-z0-9][a-z0-9._-]{0,63}$/` (`lib/infer-project.mjs:57`) **or** a literal absolute POSIX workspace path (`explicitWorkspaceFromCard`, `:32-53`). **This is the repo/project discriminator.** |
| `workKind` | **YES** | `board.mjs:111`. Names a policy work kind -> phase plan -> the card's rail. **The closest existing thing to a task type.** Values come from the compiled policy's `workKinds` map, not a hardcoded enum. |
| `kind` | **NO on the card** | Exists only on **lists** (`manual`\|`agent`\|`agent-interactive`, `kanban.mjs:78-183`, `ui/api.ts:159`) and on **events** (`ui/api.ts:35`). |
| `type` | **NO** | Only `KanbanDutyCell.type` (`src/lib/kanban-model.ts:37`), a target/runtime descriptor unrelated to cards. |
| `repo` | **NO** | Repo identity is carried by `project`. |
| `category` | **NO** | Absent entirely. |
| `taskType` | **DELETED** | Was a per-list v2 field, stripped by the v2->v3 migration at `board.mjs:42`. |

Adjacent discriminators that exist: `tier` (`:113`), `duty`/`level` (`:131-132`), `clarity` (`:137`), `quick` (`server.mjs:1044`), `origin`/`origin_id` (`:114`, `:188`), `outpost` (`:140`).

### 3.6 Where state transitions happen - scattered, funnelled through one write path

There is **no single `moveCard()`**. Every mutation goes through `saveCardCAS` (`board.mjs:311-343`), the choke point where terminal-edge side effects fire (`routeTerminalTransition` `:331`, `generateHandoffIfDone` `:334`, steering cleanup `:338-340`) - but the *decision* to move is made in 12 places.

**Engine (`lib/engine.mjs`)** - 6 sites:
1. `:516` `parkFields()` - forced move to `needs-attention`
2. `:853` `applyPendingRevisit()` - steering re-stage backwards to `directive.revisitDuty`, guarded by `isEarlierPhase` (`:845`)
3. `:1023` - forward advance in the pre-dispatch/evidence path
4. `:1687` - main dispatched-run advance to `effectiveNext`
5. `:2168` - in-session advance via `advanceCardPhase`
6. `:2710` - batched advance, per-card in a loop, with commit fences

**Server (`scripts/server.mjs`)** - 4 sites:
7. `:1005` `createCard` into `backlog` (creation, not transition)
8. `:1236` `PATCH /cards/:id` manual move (`handlePatchCard` `:1216-1370`) - validates the list `:1235`, writes recovery fields when leaving needs-attention `:1251`, requires a brief when leaving an interactive list `:1268`, auto-dispatches if the target is an immediate agent list `:1322`
9. `:1704` `POST /cards/:id/start` (`handleStartCard` `:1637-1725`) - on a manual list advances to `parkedFrom` if still valid, else `validNext[0]` (`:1687-1693`)
10. `:821` steering revisit endpoint setting `list: revisitDuty`

**Coordination (`lib/coordination.mjs`)** - 1 site:
11. `:974` - release from a `waitingOn` block

**Reconcile (`scripts/kanban.mjs`)** - 1 site:
12. `:249` `relocateStrandedCards()` (`:233-258`) - when a duty reconcile removes a list, cards on it are force-moved to `needs-attention` with `parkedFrom` + a park event

**Nearest thing to a central transition function:** `advanceCardPhase({root, board, card, verdict, ...})` at `engine.mjs:1942-2200+`. Rejects non-agent lists (`:1943-1946`), applies pending revisit steering first (`:1950-1953`), computes `validNext` from the card's resolved sequence with a fallback to static `validNext` for legacy cards (`:1959-1960`), rejects invalid verdicts (`:1961-1963`), fast-forwards over rail-OFF phases via `effectiveListForCard` (`:1970-1980`), fails safe on a corrupt policy (`:1984-1990`), enforces the D9 durable gate-evidence contract.

**The dispatched path (`engine.mjs:1687`) applies the same rules independently - the logic is duplicated, not shared.** A rule change needs both.

**Transition authority rules:**
- D16 engine-ownership lock: `isEngineOwned(board, card)` (`server.mjs:1202`). A card on an autonomous list rejects manual PATCH moves (`:1224-1231`) and deletes (`:1392-1399`) with `409 engine-owned`. Quick cards are exempt (`:1203-1205`).
- Interactive lists advance by manual Move only, never Start (`server.mjs:1663-1670`), except a clarity-gated Discuss card.
- Next-list resolution: `nextListForCard` (`resolved-model.mjs:284-290`) and `validNextForCard` (`:291-303`) - per the card's own sequence, not column order. Last element -> `"done"`.

### 3.7 Schema versioning

**Board: versioned, one real migration.** `board.version` current = **3** (`kanban.mjs:75`, `resolved-model.mjs:378`). `migrateBoard(board)` at `board.mjs:38-47` does v2->v3: strips per-list `skill`/`taskType`/`tier`/`mode`, stamps `phase = id` on agent lists, bumps to 3. Idempotent (`:40`), unknown fields survive. Applied on read and persisted back (`loadBoard` `:52-58`).

**Cards: no versioning, no migration - deliberately.** `board.mjs:155-157`: "No migration: storage is file-per-card JSON, so a V1a card simply reads these as undefined and they default on next write." Repeated at `:171-172` and `:178-179`. Consumers use `??` defaults throughout (`cardSummary`, `server.mjs:150-250`).

**Practical consequence for this audit's target:** adding a new card field (e.g. `kind`) requires **no migration**. But there is also no version stamp to key a future real migration off, and no validation rejecting a malformed card - `loadAllCards` silently skips unreadable card dirs (`board.mjs:380-391`).

**Resolved model: separately versioned.** `KanbanResolvedModel.version: 2` (`src/lib/kanban-model.ts:54`), written by `writeKanbanResolvedModel` (`:203-210`), read by `loadResolvedModel`. Absent file -> the board keeps its built-in default (`kanban.mjs:222-223`). A malformed duty graph writes an **empty** `kanbanLists` so the board falls back rather than seeding a broken pipeline (`kanban-model.ts:15-17`, `:189`).

---

## 4. Configurability assessment

| Behavior | Cadence | Hardcoded / configurable | Where |
|---|---|---|---|
| Scheduler daemon tick (60s) | 60s | **HARDCODED** | `scheduler.mjs:43` `TICK_INTERVAL_MS` - no env, no flag |
| Listener restart backoff | 1s -> 60s cap | **HARDCODED** | `scheduler.mjs:212`, `:238` |
| Scheduler health port | n/a | **Configurable** | `--health-port` / `GARRISON_SCHEDULER_HEALTH_PORT` / composition `health_port`; default `scheduler.mjs:47` |
| Jobs / log paths | n/a | **Configurable** | `GARRISON_SCHEDULER_JOBS` / `_LOG`, set per profile at `garrison-instance.sh:108-109` |
| `kanban-tick` (`*/2`) | 2 min | **Env-overridable but undeclared** - `KANBAN_TICK_CRON` (`kanban.mjs:280`), **no `config_schema` entry in `apm.yml`**, no composition key. The live job's cron has no declarative source in the repo. | `kanban.mjs:280` |
| Kanban test beat | 5 h | **Configurable at three levels** - composition `test_beat_cron` (`compositions/default/apm.yml:150`), per-list `beatCron` in `board.json` editable in the UI, env `KANBAN_TEST_BEAT_CRON`; fallback default hardcoded at `scheduler-beats.mjs:14` and `kanban.mjs:130` | - |
| Iteration cap | 10 | **Configurable** | `GARRISON_KANBAN_ITERATION_CAP`, `apm.yml` `iteration_cap` |
| Empty-gate grace window | 24 x 30s | **Configurable** | `GARRISON_EMPTY_GATE_GRACE_CHECKS` / `_INTERVAL_MS` (`engine.mjs:121-122`) |
| improver nightly | `30 3 * * *` | **Configurable** | `compositions/*/apm.yml:134` `improver.config.cron`; default `improver/apm.yml:40`; env `GARRISON_IMPROVER_CRON` |
| vault-git-sync | `0 4 * * *` | **Configurable** | `compositions/*/apm.yml:167`; default `vault-git-sync/apm.yml:33` |
| morning-briefing | configurable, **not installed** | `briefing_time` / `weekdays_only` (`morning-briefing/apm.yml:16-22`), env `GARRISON_BRIEFING_TIME` / `_WEEKDAYS_ONLY` (`setup.sh:33-34`) | - |
| snapshots daily + weekly prune | 03:00 / Sun 03:30 | **HARDCODED** | `OnCalendar` literals in committed `.timer` units; no config key, no env override. Retention likewise hardcoded at `prune.sh:13` |
| loop-heartbeat | 40 min | **Configurable** (but the fitting is dead in the default composition) | `loop-heartbeat/apm.yml:15` `cadence_minutes`, `GARRISON_HEARTBEAT_MINUTES` |
| drill heartbeat sweep | 60s | **Env-overridable** | `DRILL_HEARTBEAT_INTERVAL_MS` |
| monitor poll / ports scan / screen-share capture | varies | **Configurable** | composition `poll_interval_ms` / `scan_interval_ms`; `SCREEN_SHARE_INTERVAL_MS` |
| Most UI polls | 1s-30s | **HARDCODED literals** | §1.7. Exception: `useFittingViewStatus` `pollMs` param (`:61`) and screen-share's server-driven `state.intervalMs` |

**Targets** (the `command` string of a scheduler job) are effectively hardcoded per job - baked absolute paths written at setup time (`improver/scripts/setup.sh:64`, `vault-git-sync/scripts/setup.sh:27`, `scheduler-beats.mjs:61`). That baking is exactly why `scripts/repoint-scheduler-jobs.mjs` exists.

### 4.1 Declarative schedule formats that already exist

1. **The scheduler jobs file** - `~/.garrison/scheduler-jobs.json`. Array of `{id, cron, command, enabled, type, description?, integration?, poll_interval_ms?, last_run?, last_run_minute?}` (`scheduler.mjs:449`, `.apm/skills/scheduler/SKILL.md:79-90`). **Re-read on every tick** (`scheduler.mjs:177`), so edits take effect without a restart. This is the canonical declarative format and it already exists.
   - Cron grammar (`scheduler.mjs:66-121`): 5 fields only - `*`, `*/N`, single value, comma lists, `a-b` ranges. **No `@daily`/`@hourly` aliases, no seconds, no named months/days.** Matching is **local time**, not UTC (`SKILL.md:59`).
   - **No interval or one-shot job type.** "Every N minutes" is `*/N * * * *`. A one-shot is `run-now <id>` (manual, `:400`), not a schedulable fire-at-T entry. Interval-without-calendar work is routed to `loop-heartbeat` instead (`SKILL.md:8-10`).
2. **Composition `x-garrison` fitting config** - `compositions/default/apm.yml:134` (`cron: 30 3 * * *`), `:150` (`test_beat_cron`), `:167` (`cron: 0 4 * * *`). Replicated in `default-premium/:114,128,145`, `default-economy`, `default-build`, `secondary-minimal/:47,57`. **This is the real declarative source of cadence** - setup hooks read it and shell out to the scheduler CLI.
3. **Fitting `config_schema` defaults** - `improver/apm.yml:38`, `vault-git-sync/apm.yml:31`, `improver-nightly/apm.yml:22`, `kanban-loop/apm.yml:50`, `vault-sync/apm.yml:33`, `loop-heartbeat/apm.yml:15`.
4. **Kanban board lists** - `~/.garrison/kanban-loop/board.json`, each list carrying `{trigger: immediate|manual|scheduler-beat, beatCron}`. `scheduler-beats.mjs:34-69` translates that into a scheduler job. Live-editable via `PATCH /lists/:id` (`server.mjs:630`), validated by `tests/kanban-config-improvements.test.ts:74-92` (rejects 3-field crons, shell-ish tokens, beatCron on manual lists). Today only `test` is `scheduler-beat`.
5. **Automations YAML** - `~/.garrison/automations/<id>.yml`, `trigger.type` in `{manual, cron, webhook, listener}` (`fittings/seed/automations/lib/types.mjs:18`). **Declared but NOT wired**: nothing reads `trigger.type === "cron"` or registers anything with the scheduler; `normalizeAutomation` just defaults it to `{type:"manual"}` (`:61`). No `.yml` automations exist on disk. **This is the closest thing to an unimplemented declarative schedule surface and the most likely duplication risk** - see §6.
6. **systemd timers** - `fittings/seed/snapshots-default/systemd/*.timer`, `OnCalendar` - a deliberately Garrison-independent path (`scripts/setup.sh:33`).

---

## 5. Surfaces

### 5.1 Architecture

Cards and scheduling do **not** live in the Next.js app. The board is an own-port fitting (`kanban-loop`, port 27089) running its own Node HTTP server plus a React SPA, surfaced inside Garrison via an iframe at `/embed/kanban-loop`. The Next.js app exposes exactly **one** read-only card endpoint. Scheduling is a second standalone daemon that is CLI-driven, not HTTP-driven.

### 5.2 Kanban board server - `fittings/seed/kanban-loop/scripts/server.mjs`

Router dispatch table at `:2232-2310`; server created `:2336`; CORS preflight short-circuit `:2232`.

**Board / lists / metadata**

| Method | Path | Route | Handler | Purpose |
|---|---|---|---|---|
| GET | `/health` | 2242 | `handleHealth` @ 2069 | Liveness + board status |
| GET | `/board` | 2243 | `handleBoard` @ 852 | Full board: lists with cards (membership derived by scan) |
| GET | `/board/runtime` | 2244 | `handleBoardRuntime` @ 2121 | Live Discuss channel id + `noGateway` flag |
| GET | `/lists` | 2245 | `handleGetLists` @ 1993 | List definitions incl. triggers and beat crons |
| PATCH | `/lists/:id` | 2272-2273 | `handlePatchList` @ 2025 | Reconfigure a list; **re-registers its scheduler beat** |
| GET | `/policy` | 2250 | inline | Compiled Orchestrator policy (`~/.garrison/orchestrator/policy.json`) - work kinds, phases |
| GET | `/projects` | 2261 | `handleProjects` @ 2054 | Discoverable projects for card scoping |
| GET | `/skills` | 2262 | `handleSkills` @ 2063 | Available `garrison-*` skills |
| GET | `/operative/screen` | 2266 | `handleOperativeScreen` @ 1841 | Same-origin proxy of the gateway PTY render |

**Cards (collection)**

| Method | Path | Route | Handler |
|---|---|---|---|
| POST | `/cards` | 2267 | `handleCreateCard` @ 993 - title, description, project, goal-mode acceptance, work kind, per-card phase toggles |
| GET | `/cards` | 2268 | `handleListCards` @ 736 - query-filtered |

**Cards (per-id)** - path regex `:2292`

| Method | Path | Route | Handler | Purpose |
|---|---|---|---|---|
| GET | `/cards/:id` | 2307 | `handleGetCard` @ 880 | Full detail |
| PATCH | `/cards/:id` | 2308 | `handlePatchCard` @ 1216 | **Move / edit.** Rejects manual moves on engine-owned lists (D16) |
| DELETE | `/cards/:id` | 2309 | `handleDeleteCard` @ 1386 | Delete |
| POST | `/cards/:id/start` | 2299 | `handleStartCard` @ 1634 | Start/retry - mints runId + runDir on first agent-list entry |
| POST | `/cards/:id/abandon` | 2300 | `handleAbandonCard` @ 1459 | Abandon in-flight run |
| POST | `/cards/:id/revert` | 2301 | `handleRevertCard` @ 1529 | Revert to a prior state |
| POST | `/cards/:id/brief` | 2302 | `handleBriefCard` @ 1608 | CAS-link a Discuss brief **path** |
| POST | `/cards/:id/infer-project` | 2303 | `handleInferProject` @ 1115 | Infer project from description |
| POST | `/cards/:id/steer` | 2306 | `handleSteerCard` @ 779 | Inject steering into a running card |
| GET | `/cards/:id/watch` | 2304 | `handleWatchCard` @ 1770 | Live log/terminal stream |
| GET | `/cards/:id/handoff` | 2305 | `handleGetHandoff` @ 766 | Handoff payload |
| GET | `/cards/:id/artifact` | 2297 | `handleArtifact` @ 1886 | Read by opaque ref (`plan`, `log:2`, `evidence:after.png`) |
| PUT | `/cards/:id/artifact` | 2298 | `handleArtifactWrite` @ 1948 | Write/edit artifact |

**Origins** - regex `:2282`: `GET /origins/:id` (`handleGetOrigin` @ 747), `GET /origins/:id/events` (`handleGetOriginEvents` @ 758, incremental `since` cursor).

**Static SPA:** `:2139-2141` serves `dist/`, rewriting `/` -> `/index.html`.

### 5.3 Scheduler daemon HTTP

| Method | Path | Line | Notes |
|---|---|---|---|
| GET | `/health` and `/` | `scheduler.mjs:267-268` | **Its only HTTP surface.** Binds 127.0.0.1:27099. A busy port is non-fatal - the daemon keeps ticking without `/health` (`:277`). |

There is **no HTTP API for jobs**. Job CRUD is CLI-only (§5.6).

### 5.4 loop-heartbeat

**No server.** Outbound only: POSTs a synthetic tick to the gateway at `heartbeat.mjs:31`, target `http://127.0.0.1:24777/jobs` (`:14`, `GARRISON_GATEWAY_URL`).

### 5.5 Next.js routes

| Method | Path | File:line | Purpose |
|---|---|---|---|
| GET | `/api/board/summary` | `src/app/api/board/summary/route.ts:8` | Read-only board summary via `readBoardSummary()` |
| GET | `/api/fittings/views` | `src/app/api/fittings/views/route.ts:29,64` | Enumerates `~/.garrison/ui-fittings/*.json` - how the board's URL reaches Garrison |

**That is the entire Next.js card surface.** No card CRUD in `src/app/api/**`. `src/app/api/garrison-control/route.ts:10-15` mentions Kanban only in a comment.

### 5.6 Gateway / MCP tools

Registered in `fittings/seed/mcp-gateway/scripts/gateway.mjs`, implemented in `scripts/lib/tools.mjs`. Kanban tools gated behind `kanbanAvailable()` (`tools.mjs:69`), which discovers the board from `~/.garrison/ui-fittings/kanban-loop.json`.

| Tool | Defined | Impl | Inputs |
|---|---|---|---|
| `fetch_evidence` | `gateway.mjs:103` | `tools.mjs:77` | `card_id`, `artifact_ref` |
| `create_continuation` | `gateway.mjs:116` | `tools.mjs:104` | `card_id`, `title?`, `description?` |
| `poll_origin_events` | `gateway.mjs:130` | `tools.mjs:154` | `origin_id`, `since?` |

Dispatched `gateway.mjs:241-243`; registered `:101-140`. Adjacent task-ish tools: `classify_tier` (`:51`), `run_tests` (`:62`), `list_automations` / `run_automation` (`:78,83`), `record_improver_feedback` (`:151`), and the Soul-delegation set `talk_to` / `wait_for` / `list_active_sessions` / `end_session` / `list_workdirs` (`:169-221`). Covered by `tests/ws2-kanban-tools.test.ts:28`.

**There is no MCP tool for creating a card or for scheduling anything.**

### 5.7 CLI entrypoints

`fittings/seed/kanban-loop/scripts/kanban.mjs` (dispatch `:557-561`): `--setup` (`:557`), `--probe` (`:558`), `--tick` (`:559`), `--tick-list <id>` (`:560`).

`fittings/seed/scheduler/scripts/scheduler.mjs`: `list` (`:367`), `add <id> <cron> <command...>` (`:373`), `remove <id>` (`:390`), `run-now <id>` (`:400`), `register <id> <cron> [--disabled] [--description] [--type cron|listener] [--integration] [--poll-ms] -- <cmd...>` (`:416`), `enable`/`disable` (`:462`), `tick` one-shot (`:474`), `daemon [--health-port]` (`:480`). `register` is the idempotent form used by setup hooks - it **preserves the user's enable/disable choice** (`:448`) and `last_run` state (`:453`).

`fittings/seed/loop-heartbeat/scripts/heartbeat.mjs`: `--probe` (`:77`), `--once`, `daemon` (`:90`).

Repo-level: `scripts/repoint-scheduler-jobs.mjs` (dry-run by default `:129`, requires `--backup` with `--apply` `:71`, temp+fsync+rename `:80-97`, pre-flights that every rewritten path exists `:117-124`); `scripts/kanban-v1d-walkthrough.mjs` (`npm run kanban:v1d:walkthrough`, `package.json:25`).

### 5.8 Kanban Loop UI

**Manifest** - `fittings/seed/kanban-loop/apm.yml`: `own_port: true` (`:15`), `default_port: 27089` (`:16`), `lifecycle: operative-bound` (`:17`). Config schema `:44-56`: `board_dir`, `iteration_cap` (10), `test_beat_cron` (`0 */5 * * *`).

**There is no `x-garrison.ui.views` key.** The comment at `apm.yml:11-14` explains why: surfacing is by convention, not declaration - `server.mjs` writes a status file to `~/.garrison/ui-fittings/kanban-loop.json`, `/api/fittings/views` enumerates it, and `src/app/embed/[fittingId]/page.tsx:61` matches on `fittingId` to render the iframe (`:121`). The single route is **`/embed/kanban-loop`**.

**Noted, not fixed:** six other fittings (`snapshots-default`, `vault-sync`, `documents`, `tier-classifier`, `file-browser`, `garrison-assistant`) *do* declare a `ui:` key, so the two discovery mechanisms coexist. Anything that enumerates fitting views from manifests alone would miss the board entirely.

**Screens** - `ui/main.tsx` (1953 lines), root `App()` @ `:1667`, mounted `:1952`. One board screen plus overlays (`overlay.kind` switch `:1913-1948`):

| Screen | Component:line | Purpose |
|---|---|---|
| Board columns | `App` @ 1667 | Lists -> cards. Done column groups `quick` cards into a collapsed strip (D19, `:1889-1906`) |
| Top bar | `TopBar` @ 1935 | Brand, status, New card |
| New card sheet | `NewCardSheet` @ 444 | Title, project (auto/pick/custom), description, goal mode, **work kind**, per-phase toggles |
| Inline backlog add | `BacklogAddCard` @ 605 | Fast add in the Backlog column |
| Move sheet | `MoveSheet` @ 726 | Pick a valid next list |
| Detail sheet | `DetailSheet` @ 919 | Pointers, timeline, evidence gallery, project scope edit, abandon, revert, delete |
| Watch sheet | `WatchSheet` @ 1239 | TERMINAL (proxied PTY) + LOG tabs |
| **List config sheet** | `ListConfigSheet` @ 1460 | **Per-list trigger + cron.** `ScheduleField` @ 1402, `parseCronToForm` @ 1373, `formToCron` @ 1391 - **this is the only schedule-editing UI in the product** |
| Artifact modal | `ArtifactModal` @ 829 | View/edit; images render, text editable + savable (`:882`) |
| Timeline event | `TimelineEvent` @ 892 | Decision-log rendering |

**Card actions** (`:363-431`): Revert (`:363`), Start/Retry (`:389`,`:398`), Infer project (`:404`), Move (`:409`), Discuss (`:416`), Watch (`:420`), Continue (`:427`), Open detail (`:431`), Delete + confirm (`:1215`,`:1220`), Abandon (`:1210`).

HTTP client `ui/api.ts` (single `fetch` wrapper `:286`); build `ui/build.mjs` -> `dist/kanban.bundle.js`.

**Discuss plumbing** - `scripts/discuss.mjs:1-21`: the Discuss list is interactive and never auto-dispatched. `buildDiscussUrl` encodes the card as an **opaque base64 blob** the generic web channel forwards verbatim - the channel never learns about kanban. `recordBrief` CAS-links only the brief path.

**Manual mutation is deliberately restricted** (D16): cards on autonomous lists are engine-owned; `handlePatchCard` (`server.mjs:1216`) rejects manual moves on them, and `needs-attention` is the only human touchpoint. Any new surface that writes cards must respect this or it will fight the engine.

---

## 6. Gap analysis against the target

### Gap 1 - cards carrying a `kind` field (dev / personal / channel)

**Verdict: EXTENSION, and most of the machinery already exists under a different name.**

- `workKind` (`board.mjs:111`) already is a per-card work-type discriminator, already surfaced in the New Card sheet (`ui/main.tsx:444`), already drives rail selection through `railForCard` (`lib/policy.mjs:92-98`) reading `policy.workKinds[kind].phasePlan`. Values come from the **compiled policy**, not a hardcoded enum - so adding `personal` or `channel` as work kinds is a policy-data change, not a code change, *provided a corresponding phase plan exists*.
- Cards have **no schema version and no validation** (`board.mjs:155-157`), so adding a literal `kind` field costs zero migration.
- **The real question is whether you need `kind` at all or whether `workKind` is it.** If `kind` is meant to select a *rail*, `workKind` already does that and a second field would be redundant. If `kind` is meant to be an orthogonal *presentation/routing* axis (e.g. which board column group, which notification channel, which surface renders it) independent of the rail, then it is genuinely new - but note `origin`/`origin_id` (`:114`, `:188`) already encode "where did this come from" (`web:<threadId>` / `skill:unknown` / `board`), which overlaps heavily with a `channel` kind.
- **Duplication risk: HIGH.** Adding `kind` alongside `workKind`, `tier`, `duty`, `origin` and `project` gives the card six discriminators. Decide explicitly which one a new axis is, or the engine's resolution ladder gets a sixth input nobody can reason about.

### Gap 2 - declarative recurring sweeps defined as data rather than code

**Verdict: LARGELY EXISTS. The gap is a producer, not an engine.**

- `~/.garrison/scheduler-jobs.json` already *is* the declarative format: `{id, cron, command, enabled, type}`, re-read every tick (`scheduler.mjs:177`), with idempotent `register` that preserves user enable/disable state (`:448`).
- Composition `x-garrison` config already *is* the declarative cadence source (`compositions/default/apm.yml:134,150,167`), consumed by setup hooks that shell out to the scheduler CLI.
- `scheduler-beats.mjs:34-69` already *is* the pattern for "board data -> scheduler job", with live re-registration on `PATCH /lists/:id` and cron validation in tests (`tests/kanban-config-improvements.test.ts:74-92`).
- **What is missing:** a sweep is currently expressed as a *shell command string* baked with absolute paths at setup time. There is no format for "sweep the board with these filters and produce this output" as data. Each new recurring behavior today needs a new `.mjs` entrypoint plus a `register` call in a setup hook.
- **Duplication risk: HIGH - the automations fitting.** `fittings/seed/automations/lib/types.mjs:18` already declares `trigger.type in {manual, cron, webhook, listener}` in a YAML format at `~/.garrison/automations/<id>.yml`. **Nothing implements the cron branch** - `normalizeAutomation:61` defaults everything to `{type:"manual"}` and no `.yml` files exist. If you build a new declarative recurring-sweep format, you will be building the thing `automations` already declared. Decide up front whether to finish `automations` or to retire that trigger enum.
- **Also note:** the cron grammar is 5-field only, local-time, with no `@weekly`/`@daily` aliases (`scheduler.mjs:66-121`). Any richer schedule language means extending `matchCron` or layering on top.

### Gap 3 - a weekly Monday review sweep (assemble board state, flag stalled cards)

**Verdict: GENUINELY MISSING on all three counts.**

- **No weekly/Monday job exists.** Confirmed: no cron job anywhere uses a day-of-week field other than `1-5` (morning-briefing's weekdays translation, which is not installed). The only genuinely weekly scheduled thing in the repo is `garrison-snapshots-prune.timer:5` (`OnCalendar=Sun *-*-* 03:30:00`) - a systemd timer, not a scheduler job. "Monday" appears only at `fittings/seed/coord-mcp/scripts/lib/lookback.mjs:11` as a lookback-window heuristic. **The cron parser does support `* * * * 1`** (single value in the DOW field, `scheduler.mjs:66-121`), so the schedule itself is a one-line `register` call.
- **No board-state assembly exists.** The closest is `readBoardSummary()` behind `GET /api/board/summary` (`src/lib/board-summary.ts`, route `src/app/api/board/summary/route.ts:8`) and `handleBoard` (`server.mjs:852`). Both are point-in-time reads for a UI, not a report. `writeDutySummary` (`engine.mjs:788`, called `:1818-1829`) rolls up **per-card per-advance**, not across the board. **Extension of `readBoardSummary`, not greenfield.**
- **No stall detection exists - this is the hard part.** §2.6 established that `recoverInterruptedRuns` (`engine.mjs:1881-1908`) is **boot-only**: it clears cards left `running` by a crash when the board server starts, and does nothing else, ever. A card whose owning process is alive but hung stays `running` indefinitely. There is **no time-based sweep** and **no age threshold anywhere in the engine**. The raw material is present - `runningSince` (`board.mjs:148`), `updated` (`:183`), `stabilityAt` (`:174`), `planCompletedAt` (`:175`), `waitingOn.since` (`ui/api.ts:43-52`) - but nothing reads any of them against a clock except the UI's cosmetic elapsed counter (`ui/main.tsx:327`). **Genuinely missing; needs a new predicate, though it reads existing fields.**
- **Note:** `needs-attention` already has `notifyOnEntry: true` (`kanban.mjs:181`) and a notify path (`lib/notify-origin.mjs`). A Monday sweep flagging stalled cards should probably route through that rather than inventing a second notification channel.

### Gap 4 - non-dev tasks flowing through the same states

**Verdict: PARTIALLY EXISTS structurally; the *content* of every state is dev-specific.**

- **The board is already dynamic.** `buildBoard(model, opts)` (`resolved-model.mjs:315-380`) constructs lists from `model.kanbanLists` with a fixed human head `["backlog","todo"]` (`:31`) and tail `["done","needs-attention"]` (`:32`). Nothing structurally requires dev phases in between.
- **But every list it can build is a dev phase.** `GATE_PHASES` (`resolved-model.mjs:38-45`) is hardcoded to `review, adversarial-review, test, adversarial-test, walkthrough, validate`, all looping back to `implement`. The seed pipeline (`kanban.mjs:73-187`) is entirely dev. The per-phase prompts (`kanban.mjs:99-175`) assume a repo, a runDir, a slice, and a diff.
- **The evidence contract is dev-shaped and hard-enforced.** `requiresEvidence` on walkthrough (`kanban.mjs:157`) demands a non-empty `<runDir>/evidence/`; `test.requiredEvidenceFile: "evidence.md"` (`:138`); `evidenceContractForTransition` (`engine.mjs:227`) and `gateContractForTransition` (`:243`) enforce durable `gate-status.<phase>.json` files. A personal task has no evidence to produce, and the engine parks rather than advancing when the contract is unmet (`:1452-1457`, `:1463-1488`, `:1753`). **This is the single biggest blocker to non-dev flow.**
- **The per-card OFF-phase mechanism is the existing escape hatch.** `phases: Record<string,bool>` (`board.mjs:112`) plus rail fast-forward (`engine.mjs:985-1029`) already lets a card skip phases without dispatching. A "personal" work kind whose phase plan is essentially `[todo -> done]` may be expressible today purely as policy data. **Worth prototyping before writing code** - the answer may be that Gap 4 is entirely a policy-authoring exercise. But note the caveat at `:1000-1020`: an OFF Test that would fast-forward to Done **still requires `evidence.md`**. That special case has to be relaxed for a genuinely evidence-free rail.
- **The 12 scattered transition sites (§3.6) are the change surface.** Because `processCard` (`engine.mjs:1687`) and `advanceCardPhase` (`:1942+`) duplicate rather than share the advance rules, any relaxation of the evidence contract for non-dev kinds has to be applied in **both**, plus `processBatch` (`:2321-2806`). This is the concrete cost of the duplication.

### 6.1 Cross-cutting things you would be duplicating

1. **`fittings/seed/automations/`** - already declares a cron trigger type that is unimplemented (§4.1 item 5). Highest duplication risk.
2. **`fittings/seed/loop-heartbeat/`** - a working, configurable, interval-driven "wake the operative and suggest tasks" daemon that is **dead in the default composition** but alive in `compositions/dogfood-orch/apm.yml:11,39`. If the target is "periodically nudge the operative about non-dev work", this fitting already does approximately that.
3. **`fittings/seed/morning-briefing/`** - a complete, tested, configurable time-of-day + weekday-filter recurring job (`tests/morning-briefing-cron-translation.test.ts`) that is not installed in any composition. Its `--cron` translation logic (time + weekdays -> cron string) is exactly what a Monday-review scheduler UI would need.
4. **`scheduler-beats.mjs`** - the board-data-to-scheduler-job bridge already exists and is the right pattern to extend for board-driven sweeps.
5. **`readBoardSummary()` / `handleBoard`** - board-state assembly exists in read-only form; a review sweep should extend it, not re-walk the cards directory.

---

## 7. Issues found but deliberately not fixed

Per the audit brief, these are recorded rather than repaired:

1. `data/scheduler-jobs.json` (committed) is stale and contradicts the live `~/.garrison/scheduler-jobs.json` (§1.3).
2. Two scheduler daemons share one unlocked jobs file; `last_run_minute` is a read-modify-write race (§1.9 #1).
3. `~/.config/systemd/user/garrison-scheduler.service` points at `~/dev/garrison-codex`, a different checkout (§1.4 #6).
4. `compositions/default/.claude/skills/scheduler/SKILL.md:112-127` and `:17-21` are both stale versus `garrison-instance.sh:187` and `apm.yml:17` (§1.9 #4).
5. The live codex scheduler runs on `--health-port 27999`, not the 27099 the profile table predicts (`src/lib/instance-profile.ts:29-42`) (§1.9 #5).
6. `KANBAN_TICK_CRON` - the actual global cadence - has **no `config_schema` entry** in `kanban-loop/apm.yml`, while the far less central `test_beat_cron` does (§4).
7. `fittings/seed/kanban-loop/README.md:63` documents the run dir as project-relative `docs/autothing/runs/<runId>`; the code (`engine.mjs:349-352`) uses absolute `~/.garrison/runs/<projectLabel>/<runId>`.
8. Advance logic is duplicated across `processCard` (`engine.mjs:1687`), `processBatch` (`:2321-2806`), and `advanceCardPhase` (`:1942+`) rather than shared (§3.6).
9. `fittings/seed/automations/lib/types.mjs:18` declares `trigger.type: cron` with no implementation (§4.1 item 5).
10. Two competing fitting-view discovery mechanisms coexist (manifest `ui:` key vs runtime `~/.garrison/ui-fittings/*.json`); a manifest-only scan misses the board (§5.8).
11. `fittings/seed/web-channel-default/ui/legacy-voice.tsx:413` and `fittings/seed/vault-sync/ui/VaultSyncStatus.tsx:41` both look dead in the default composition (§1.7).
12. `improver-nightly` is registered and enabled but has never written a `last_run`, corroborating `docs/DECISIONS.md:493` (§1.3).
13. All four live scheduler job commands point at `compositions/default/apm_modules/_local/...`, so edits to `fittings/seed/` do not reach cron until re-install (§1.3).
