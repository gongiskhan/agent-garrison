I'll explore the Garrison codebase to produce evidence for the three findings. Let me start with broad reconnaissance across the Kanban engine, the three entry doors, and the run engine.
Strong leads. Let me dig into the Kanban loop fitting, the run engine, the gateway, and the garrison skill in parallel.
The Kanban engine lives in `fittings/seed/kanban-loop/`. Let me read its core files.
Now let me find where the default lists/columns are defined and read the engine and policy.
Found the hardcoded columns in `scripts/kanban.mjs`. Let me read that default board definition and the engine.
Now the engine and policy. Let me read both.
Let me continue reading the engine to see how empty replies and the failure outcomes are handled.
Now let me read the policy module and search for `delegate(` calls plus disk artifacts.
Let me search for `delegate(` calls and examine on-disk run artifacts for the owner's failure evidence.
Let me examine the delegate() runtime bridge and its result handling, plus the agent-sdk primary bridge.
The delegate bridge's `summarize("")` returns `"(no output)"` which passes validation. Now let me check the on-disk run/card artifacts and the agent-sdk primary bridge.
Let me dig into the actual cards and run directories for the owner's failure evidence.
The parked card confirms an empty Implement output. Let me read its logs and run dir, then check whether any Done cards advanced past an empty Implement via the gate-evidence rescue.
This is the smoking gun for E9. Let me check the exact timestamps to see whether the gate file existed when the engine parked the card.
E9 is now clear: the operative was still working when the gateway returned an empty reply, and it wrote `gate-status.implement.json` ~2.5 min AFTER the engine already parked. Let me now cover the goal hook, lifecycle events, add-card UI, and the three doors. Reading the garrison skill and its hooks.
Let me read the goal Stop hook and the sentinel it consults, plus check what's installed.
The goal hook consults only the per-session sentinel and transcript, not the board. Now let me enumerate the lifecycle event kinds, the add-card UI, and the web-channel/gateway door.
The add-card UI exists (`NewCardSheet`). Let me read it and the server's card-creation + notification path, then the gateway door.
The add-card UI is real (creates into Backlog). Now let me read the server's card-creation path, notification handling, and the api. Then pivot to the gateway door.
Now the gateway door. Let me read the gateway's autonomous-card path and how it decides quick-vs-full.
The gateway lands task-shaped turns in Plan by default, or Implement→Done for "quick" cards. Let me find where "quick" is decided and how the web-channel invokes this.
Let me read the gateway.mjs decision logic that chooses quick-vs-full and the `significant` signal.
Let me verify the significance threshold, the gateway payload builder, and the notification/finished-event story.
Concrete divergence confirmed on disk: "build a task list app" (T1) ran the full gated pipeline, while "build a nice webpage" (T0-trivial) was a quick card straight to Done. Let me confirm the quick card's lack of gates and check the notification/finished-event story.
I have complete evidence for all three findings. Here is the structured report.

---

# FINDING-E7 — The Kanban engine

**(a) Hardcoded COLUMNS/lists.** All 13 lists are hardcoded in one place: `fittings/seed/kanban-loop/scripts/kanban.mjs:41-144` `seedBoard()`. In order: `backlog`, `todo`, `discuss`, `plan`, `implement`, `review`, `adversarial-review`, `test`, `adversarial-test`, `walkthrough`, `validate`, `done`, `needs-attention`. This is written once to `~/.garrison/kanban-loop/board.json` on `kanban.mjs --setup` (`kanban.mjs:184-196`) and never re-seeded. The live board matches exactly (verified via `~/.garrison/kanban-loop/board.json`, version 3). There is **no separate server-side column list** — `board.json` is the sole source; list *membership* is derived by scanning cards, never stored (`lib/board.mjs:deriveMembership`, and the header comment at `board.mjs:1-6`). A one-shot v2→v3 migration strips dead per-list config and stamps `phase = id` on agent lists (`board.mjs:37 migrateBoard`). Each list carries `kind` (`manual` | `agent` | `agent-interactive`), `trigger` (`immediate` | `manual` | `scheduler-beat`), a `phase`, and a `validNext` array.

**(b) Where the PHASE SEQUENCE lives.** It is expressed in **two layers**:
- *The spine (allowed edges):* each agent list's `phase` + `validNext` array in `seedBoard()` (e.g. `implement` → `validNext:["review"]`, `review` → `["adversarial-review","implement"]`). The forward pipeline is `plan → implement → review → adversarial-review → test → adversarial-test → walkthrough → validate → done`, each gate list also carrying an `implement` fail-edge.
- *The rail (which subset actually runs):* the compiled policy at `~/.garrison/orchestrator/policy.json` — its `phases` array + per-work-kind `phasePlans`, resolved by `railForCard` (`lib/policy.mjs:91`) with per-card `phases` toggles merged over it (D17). A pipeline phase not in the plan is OFF and fast-forwarded (`engine.mjs:effectiveListForCard:185`). `phaseForList` (`policy.mjs:57`) is literally `list.phase ?? list.id`.

**(c) What decides the next phase.** Two different mechanisms depending on the door:
- *Board-tick path (the common one):* the engine parses the operative's **router verdict** — `parseNextList` (`engine.mjs:280`) takes the last bare token, strips `[…]` badges, and **exact-matches** it against `validNext`. The transition additionally **requires durable gate evidence**: `hasPhaseGateEvidence(cwd, runDir, phase)` (`policy.mjs:244`) must find a `gate-status*.json` entry for the phase in the runDir, or the card parks (`engine.mjs:781`). A backstop reads `next_phase` straight from the gate file when the reply lost its token — `gateEvidenceNextList` (`policy.mjs:208`, called at `engine.mjs:730`).
- *The GOAL HOOK* (`~/.claude/skills/garrison/hooks/garrison-goal-stop.sh`, a `Stop` hook) is used **only by the in-session garrison-doorway path, not the board tick.** It consults the **per-session sentinel** `~/.garrison/sentinels/<session_id>.json` (fields `iteration`, `turnCap`, `runId`, `probe`) and the session **transcript** (greps for `GLOBAL GATE:.*<runId>.*videos:N/N`). It does **not** read the board, card, or policy and does **not** choose a phase — it only blocks the stop to force another turn until the terminal `GLOBAL GATE` line prints or `turnCap` is hit. Per `SKILL.md:59`: "the hook owns liveness WITHIN a phase; the board owns progression BETWEEN phases." The board-tick path instead guards with the **iteration cap** (`kanban.mjs:35-36` "the guard is the iteration cap, not a goal hook (Decision 7)"; enforced `engine.mjs:457`). Note: `~/.garrison/sentinels/` is currently **empty** — the goal-hook path is dormant right now; cards are being driven by the board tick.

**(d) Where lifecycle EVENTS are emitted — and not.** Every transition appends to the card's own `events[]` array via `withEvent` (`engine.mjs:220`) — a **board-local timeline**, capped at 60. Emitted kinds (grep of `lib/*.mjs`+`scripts/*.mjs`): `created`, `inference`, `dispatch`, `routed`, `parked`, `failed`, `deferred`, `interference`, `phase-off`, `recovered`, `coordination`, `fence`, `mail`, `wait`, `stability`, plus `moved` on manual moves. **Gaps:**
- **No `finished`/`done`/`completed` event** — reaching Done is just a `routed` or `moved` event.
- **No `needs-input` event** — landing on Discuss (interactive) is only a `moved` + the list's `onEnter:"open-web-chat"` flag; nothing notifies.
- **No generic `blocked` event** — coordination uses `wait`/`interference` instead.
- **No external emission of any kind.** There is no webhook/push/Slack from the kanban engine. `notifyOnEntry` (set only on `needs-attention`, `kanban.mjs:138`) is a **boolean flag in the projection** (`server.mjs:114`) that "the surface honours" — but there is **no emitter** in kanban-loop. The only external notification in the whole system is the separate `garrison-report` **skill** (Slack), which is the skill door's final step, not the board engine.

**(e) The add-card "gap" is NOT a gap.** There is a real add-card UI: `NewCardSheet` (`ui/main.tsx:380`, sheet titled "New card → Backlog"), opened by the **"New card"** button (`ui/main.tsx:1624`). It collects **title** (optional, inferred from description if blank), **project** (auto-infer / pick-from-dev-root / custom path), **description**, a **goalMode** checkbox, and **workKind + per-phase toggles**. `submit()` calls `api.create()` (`ui/api.ts:309`) → `POST /cards` (`server.mjs:846`) which always creates in `list:"backlog"` (`server.mjs:861`). So a human can add a card to Backlog with title/description/project today.

---

# FINDING-E8 — The three doors

**Door 1 — web-channel direct dispatch (gateway).** Entry: `maybeCardChannelTurn` (`fittings/seed/http-gateway/scripts/gateway.mjs:174`, souls mode) / `gateway-pty.mjs:367` (routed mode). It **classifies** the turn: explicit hint → `classifyByKeywords(routingConfig)` → `heuristicClassify` (`autonomous-cards.mjs:41`). Only `code/research/writing/image/video/ops` are "task-shaped" (`autonomous-cards.mjs:22`); `other`/`review` are plain conversation, no card. For a task-shaped turn it consults `isSignificantAutonomous` (`orchestrator/lib/policy-core.mjs:615`: a `BUILD_VERBS` task type, or `code`/`ops` at tier ≠ `T0-trivial`) plus a conversational **override** (`feedback-queue.mjs` "keep it quick"/"do it properly"):
- **significant →** `createAutonomousCard(..., {})` → lands in **`plan`** → full engine pipeline; replies "Registered as a run" + card link, turn not forwarded (`gateway.mjs:229-239`).
- **not significant →** **quick card** → lands in **`implement`**, runs **inline in the same turn**, then `completeQuickTurnCard` moves it **Implement → Done** (`gateway.mjs:241, 254`).

**Door 2 — the Kanban loop (board-driven pickup).** The card already exists. A scheduler job runs `kanban.mjs --tick` every 2 min (`registerTick`, `kanban.mjs:165`) plus a Test scheduler beat. `tick()` → `processCard` (`engine.mjs:432`) for each **immediate agent-list** card. It consults the **board list defs** (`validNext`) + the **compiled policy** (`phaseForList`, `skillForPhase`, `classificationForPhase`, `railForCard`) + coordination config. There is **no classifier** — the list *is* the task type, tier rides on the card, and every phase requires router-verdict + durable gate evidence + (walkthrough) `requiresEvidence`.

**Door 3 — the garrison skill (thin doorway).** `SKILL.md`: Step 1 read `policy.json` (hard-stop if absent). Step 2 `POST /cards {goalMode:true, workKind (--kind|policy.defaultWorkKind), phases (--no-<phase>), tier, origin:"garrison-doorway", project:cwd}` then `PATCH → plan` with the `x-garrison-engine` header. Step 3 drive the run **in-session** via `advanceCardPhase` (`engine.mjs:1129`), armed by the goal Stop hook. It consults the **compiled policy** (defaultWorkKind, phases, phase-skill bindings) and the card's rail; always full pipeline, never quick.

**DIVERGENCE LIST (same task "build X" gets different fates):**
1. **Quick-card bypass (biggest).** The gateway can classify a short `code` task as `T0-trivial` and shove it **Implement → Done inline**, skipping plan / review / adversarial-review / test / adversarial-test / walkthrough / validate **and** durable-gate enforcement. The board UI and the skill always run the full gated pipeline. **On-disk proof:** `01KX8ZP28CS205W4N8BYF2APZG` "build a nice webpage for garrison" (`quick:true`, `tier:T0-trivial`) went `Backlog → Implement → Done` in **1 run** with no review/test/validate; `01KXD5E1PA43ZSYWN50W8T5M75` "build a task list app" (`tier:T1-standard`) got the full `Plan → Implement …` gated pipeline. Same "build" verb, opposite treatment — tier alone decides.
2. **Empty-output disposition disagrees** (crosses into E9). The quick path marks an empty Implement **Done** (`completeQuickTurnCard` only blocks a reply starting with `"[operative error]"`, `gateway.mjs:256`); the board engine **parks** empty Implement output in needs-attention (`engine.mjs:1005`). Same empty result → Done vs needs-attention.
3. **Entry list.** Gateway-significant → `plan`; gateway-quick → `implement` (skips FLOW_PLAN/acceptance/touch-set entirely); skill → `plan`; board UI → `backlog` (a manual list — sits until a human Move or project-inference, **never auto-dispatched**).
4. **Classification authority.** Significance/tier is computed **only on the gateway door**; the board door treats the list as the task type; the skill uses `policy.defaultWorkKind`.
5. **goalMode.** Skill + gateway force `goalMode:true` (`buildAutonomousCardPayload`, `policy-core.mjs:630`); the board UI leaves it a user checkbox (default false) — so `/goal` is prepended or not depending on the door.
6. **Execution substrate.** Board-tick = an out-of-band scheduler dispatching a **fresh gateway `/chat` turn per phase**; skill = the **same in-session operative** looping every phase under the goal hook; gateway-quick = **one inline turn, no phase loop**.
7. **Human-in-the-loop.** Only the board UI can route a task through **Discuss**; the gateway and skill go straight to plan/implement and never offer it.

---

# FINDING-E9 — The empty-output Implement failure

**(a) Where delegate() results are consumed.** The run-engine phase executor is `processCard` (`engine.mjs:432`); it consumes the **`runFn`** result (`out.reply`, `engine.mjs:701`), not `delegate()` directly. The literal `delegate()` is the **runtime-to-runtime bridge** `packages/claude-pty/src/runtime-bridge.mjs:70`, consumed by the runtime fittings' `bridge.mjs` (`agent-sdk-runtime:117`, `codex-runtime:160`, `gemini-runtime:68`, `opencode-runtime:97`). It returns `{summary, artifacts}`.

**(b) Where EMPTY output is treated as success — three places (no empty-diff check anywhere):**
1. **Delegate bridge.** `summarize("")` returns the **non-empty** string `"(no output)"` (`runtime-bridge.mjs:143-146`), so `validateDelegationResult` — which only checks `summary.length` (`runtime-bridge.mjs:53-59`) — **passes**. An empty delegation is a "valid" success result.
2. **Gateway quick card.** `completeQuickTurnCard` (`gateway.mjs:254`) advances Implement → Done for any reply not starting with `"[operative error]"`; an empty reply advances to Done. The move is a `x-garrison-engine` PATCH to a terminal list and is **not gate-checked** (quick cards are `quick:true` → excluded from the engine-owned guard, `server.mjs:946-950`).
3. **Board engine durable-gate rescue.** An empty Implement reply with a present `gate-status.implement.json` advances to Review (`gateEvidenceNextList`, `engine.mjs:730` + `hasPhaseGateEvidence`, `engine.mjs:781`) — the gate check only verifies the gate **file** exists and names a `next_phase`, **never that a diff/code was actually produced**.

The board engine *does* have an explicit empty-reply park (`engine.mjs:1005`) that fires only when there is no verdict **and** no rescuing gate file.

**(c) The owner's failure evidence on disk.** Card **`01KXD5E1PA43ZSYWN50W8T5M75`** "build a task list app", now in `needs-attention`, `parkedFrom:implement`, `attentionReason:"The Implement run produced no output — the operative returned nothing…"`.
- Empty operative reply: `~/.garrison/kanban-loop/cards/01KXD5E1PA43ZSYWN50W8T5M75/log-2.md` is literally `# iteration 2\n\n` (15 bytes, no reply body).
- runDir: `~/.garrison/runs/no-project/01KXD5ENZ19FY3QAV4Q6F8QWN6/`.
- **Timeline (mtimes, local +0100):** 08:20:30 Implement dispatched → **08:21:43** `log-2.md` written (runFn returned empty) → **08:22:05** `card.json` PARKED "operative returned no output" → **08:23** `node_modules/`, `e2e/`, `dist/`, `.git/` appear in `/home/ggomes/dev/task-list-app` → **08:24:17** `gate-status.implement.json` written (`status:"passed"`, `next_phase:"review"`, notes claim "7/7 unit tests passing… Committed").

**Root cause (this is the inverse of "empty marked done"):** the gateway/`runFn` returned an **empty reply while the operative was still doing the Implement work**. The engine parked for empty output because at 08:22:05 there was no verdict and **no gate file yet** — it landed **~2.5 minutes later** at 08:24:17. The operative in fact built the app on disk (`/home/ggomes/dev/task-list-app`, with git/dist/e2e) and self-reported success, but the card was already parked. The durable-gate rescue at `engine.mjs:730` would have caught this **had the gate file existed at park time** — it missed purely on timing. So the owner's concrete failure is a **premature-empty-return race** parking a genuinely-succeeding run; the "empty treated as success" hazard is real but lives on the *other* two paths (quick-card completion and the delegate bridge), not this gated one.

No files were modified.
