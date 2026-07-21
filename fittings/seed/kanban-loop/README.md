# kanban-loop (V1b engine)

A workflow state machine wearing a Kanban board. **Cards** are work items; **lists**
are pipeline states; an **agent-list**'s router-prompt is the transition function.
It composes the orchestrator (preRoute), the garrison skills, and the scheduler — it
does **not** become a runtime framework (compose, don't own). This is the V1b engine
spine; the board UI is owned by other V1b slices.

## Storage (`~/.garrison/kanban-loop/`, override `GARRISON_KANBAN_DIR`)
- `board.json` — list defs + order + per-list config (never membership).
- `cards/<ulid>/card.json` — the card, storing **pointers, never inlined bodies**:
  `runId`, `runDir`, `sliceId`, `sessionIds[]`, `briefPath`, `videoUrl`, plus title,
  project, list, status, iterations, goalMode, acceptance, ts.
- `cards/<ulid>/log-N.md` — per-iteration logs.

ULID ids (so concurrent drops never race), atomic writes (temp + rename),
read-immediately-before-write + compare-and-swap (rev) on every mutation. **List
membership is derived by scanning cards — never stored.**

## The pipeline (seed board)

`Backlog → To Do → Discuss → Plan → Implement → Review → Adversarial Review → Test →
Adversarial Test → Walkthrough → Validate → Done`, plus the `needs-attention` parking
lane. Every agent list runs one `garrison-*` verb. The two adversarial lists are
cross-model Codex passes via the `codex` CLI — **not** a higher tier (the operative
stays modest).

| id | kind | trigger | skill | class | validNext |
|---|---|---|---|---|---|
| backlog | manual | manual | — | — | todo |
| todo | manual | manual | — | — | discuss, plan |
| discuss | agent-interactive | manual | (James mode) | — | plan |
| plan | agent | immediate | garrison-plan | code · T2-deep | implement |
| implement | agent | immediate | garrison-implement | code · T2-deep | review |
| review | agent | immediate | garrison-review | review · T1 | adversarial-review, implement |
| adversarial-review | agent | immediate | garrison-adversarial-review | review · T1 | test, implement |
| test | agent | scheduler-beat | garrison-test | code · T1 | adversarial-test, implement |
| adversarial-test | agent | immediate | garrison-adversarial-test | code · T1 | walkthrough, implement |
| walkthrough | agent | immediate | garrison-walkthrough | code · T1 | validate, implement |
| validate | agent | immediate | garrison-validate | ops · T1 | done, implement |
| done | manual | manual | — | — | (terminal) |
| needs-attention | manual | manual | — | — | todo, plan, implement |

## Engine (`lib/engine.mjs`)
A **manual** list is a plain column. An **agent** list has a named `skill` +
`executePrompt` + `routerPrompt`. On entry an **immediate** agent list builds the
combined prompt (with the card's `runDir` threaded in as literal text) and sends it
through the orchestrator front door (an injected `runFn` = preRoute / gateway
`/chat`), then the router output's last non-empty line must **exactly** name one of
the card's valid next lists (no fuzzy matching, no guessing) or the card parks in
`needs-attention`. A per-card **iteration cap** breach also parks it.

### Triggers
Each list carries one of three triggers:
- **immediate** — fires on entry via `--tick`.
- **scheduler-beat** — only the **Test** list; fires on its own beat (see below).
- **manual** — advanced by hand; **interactive** lists (Discuss) open the web chat and
  the human advances. `tick()` processes only immediate agent lists.

### runId minting + threading (FINDING 4 / Decision 5/10)
On a card's **first** agent-list entry the engine mints `runId` (a ULID) and sets
`runDir = docs/autothing/runs/<runId>` (project-relative), persisted CAS-safely in the
same acquire write so it is never minted twice. `runDir` (and `sliceId`) are threaded
into **every** subsequent execute-prompt as literal text — the gateway `skill` field is
inert, so the run dir must be IN the prompt for the garrison skill to write per-run.

### Test batching (FINDING 7)
The **Test** list runs batched **per project**: `processBatch` groups the project's
waiting Test cards, runs **one session per project** against one test plan, and parses
**one verdict per card** (`<cardId> <next-list>`) — each card moves per its own verdict
(pass → `adversarial-test`, fail / no-match / cap → `implement` or park). It fires on
the Test scheduler beat, **not** the global heartbeat.

### Backlog inference (FINDING 3)
`resolveBacklogInference` is the policy half: it keeps the eagerly-inferred title but
applies the inferred project **only at ≥70% confidence**; below that the card parks in
`needs-attention` (no Infer column — §9).

## §9 decisions (accepted)
- **Effort/model are the router's job** — no per-list model; the engine sends a
  `{taskType,tier}` classification and preRoute resolves the target (honored in both
  gateway modes via the souls-hint slice).
- **Skill is explicit per list** (one skill-decider per list, one effort/model decider
  in the router — no overlap).
- **Suppress the router's continuations** under kanban (the list boundary is the gate).
- **No Infer column** — low-confidence inference parks in `needs-attention`.
- **Adversarial = cross-model Codex**, not a higher tier and not a separate effort.

## Goal-mode
A `goalMode` card on an agent list has the engine lead with an explicit acceptance
block; execute-prompts stay clean. It deliberately does not invoke the host-specific
`/goal` slash command because a combined phase prompt would be parsed wholesale as
that command's argument. The convergence **guard is the per-card iteration cap**, not
the goal-stop hook (Decision 7 — the sentinel never fires on the shared board operative).

## CLI
`node scripts/kanban.mjs --setup | --probe | --tick | --tick-list <id>`.
- `--setup` seeds the board **and** registers the Test scheduler beat
  (`kanban-test-beat`, default cron `0 */5 * * *`, override `KANBAN_TEST_BEAT_CRON`).
- `--tick` dispatches due immediate agent-list cards through `GARRISON_GATEWAY_URL`.
- `--tick-list test` runs the batched Test path (one session per project); the Test
  beat calls exactly this.
