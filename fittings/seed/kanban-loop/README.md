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
  project, scope, list, status, iterations, goalMode, acceptance, ts.
- `cards/<ulid>/log-N.md` — per-iteration logs.
- `memory-outbox/personal-completions/` — immutable, bounded source packets for
  personal cards that reach Done. This is a provider-neutral handoff; Kanban never
  writes directly to a vault while committing a card.

ULID ids (so concurrent drops never race), atomic writes (temp + rename),
read-immediately-before-write + compare-and-swap (rev) on every mutation. **List
membership is derived by scanning cards — never stored.**

## Project and personal scope

`scope` and `project` answer different questions:

- `scope: personal` classifies the task as personal. It may still carry a real
  project and may run on any manual or agent list.
- A real project, including one corrected after inference, is the execution cwd.
  Correcting the card project also removes any stale run-spec project override so
  the visible project and actual next-run cwd cannot disagree.
- A personal card with no project runs in the private, fixed
  `$GARRISON_HOME/personal` workspace. `--setup` creates it with mode `0700` and
  create-if-absent Claude/Codex/Gemini policy files; runtime resolution rejects a
  missing, replaced, or symlinked workspace instead of falling back elsewhere.
- An ordinary card with neither a project nor the personal label remains
  unscoped and is eligible for project inference.

Project and personal scope can be edited while a card is human-held and before
its first run. Once `runId` exists they are fixed because the run's cwd, evidence,
and handoff already belong to that execution context; create a fresh card to run
the task somewhere else.

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
`runDir = $GARRISON_HOME/runs/<project-or-scope>/<runId>`, persisted CAS-safely in
the same acquire write so it is never minted twice. Project-less personal runs use
the `personal` segment. `runDir` (and `sliceId`) are threaded into **every**
subsequent execute-prompt as literal text — the gateway `skill` field is inert, so
the run dir must be IN the prompt for the garrison skill to write per-run.

### Test batching (FINDING 7)
The **Test** list runs batched **per execution scope**: `processBatch` groups a
project's waiting Test cards, or project-less personal cards together, runs **one
session per scope** against one test plan, and parses
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
- `--setup` seeds the board, initializes the confined personal workspace, **and**
  registers the Test scheduler beat
  (`kanban-test-beat`, default cron `0 */5 * * *`, override `KANBAN_TEST_BEAT_CRON`).
- `--tick` dispatches due immediate agent-list cards through `GARRISON_GATEWAY_URL`.
- `--tick-list test` runs the batched Test path (one session per execution scope); the Test
  beat calls exactly this.

## Personal completion memory

When an explicitly personal card reaches Done, Kanban emits one bounded packet for
that completion generation after the card lock is released. Reopening and completing
the card creates a new generation; retries are idempotent, and startup reconciliation
repairs the narrow commit-before-packet crash window.

When the Basic Memory fitting is equipped, its scheduled consumer writes the packet
to `Personal/Kanban Completions/kanban-<card>-g<generation>.md` in the configured
memory backend. The note records provenance, the bounded user-authored description
and checklist, and any bounded agent closeout/evidence references. It deliberately
omits transcripts, logs, diffs, environment values, attachment bodies, and session
identifiers, and redacts common credential shapes.

These are **completion source records**, not automatically promoted personal facts.
Card text and agent summaries remain explicitly marked unverified so a vague task
description cannot silently become timeless memory. The stable personal cwd may also
give a runtime its normal cwd-scoped native memory namespace, but that is separate
from this deterministic, cross-runtime Basic Memory capture; a `.claude` directory is
neither required nor treated as the memory store.

## Moving and transferring tasks

- **Move** can send a card to any board list. **Advance** remains the guarded
  workflow action: it follows the card's viable next lists and may ask which branch
  to take.
- Newly created, imported, and button-moved cards are placed at the top of their
  destination list. Drag-and-drop keeps the explicitly chosen position.
- **Export** downloads a portable JSON bundle for the whole board or one list.
  Bundles contain task content, not machine-local project paths, run/session ids,
  runtime state, or attachment paths.
- **Import tasks** accepts either a Garrison task bundle or a raw Trello board JSON
  export. Imports go only to human-held lists and receive fresh Garrison ids; they do
  not resume old execution state.

### Importing a Trello list

1. In Trello, open the board, choose **Board menu → Print, Export and Share →
   Export as JSON**, and save the downloaded file.
2. In Garrison's Kanban toolbar, choose **Import tasks** and select that JSON file.
3. Choose one source list (or all open cards), optionally include archived cards,
   choose the Garrison destination list, review the count, and import.

The adapter preserves card titles, descriptions, labels, due dates, checklist text
and completion state, and safe `trello.com` source links. It intentionally excludes
members, comments, actions, attachments, and Trello ids. The same normalized import
boundary can later accept a connector-fed Trello payload without changing board
storage or import semantics.
