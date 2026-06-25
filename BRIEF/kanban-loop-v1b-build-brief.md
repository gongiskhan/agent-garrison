# BRIEF: Kanban Loop V1b, board, web chat, and engine completion

## What this is

The build brief for the second stage of Kanban Loop. The V1a engine already exists and is tested at `fittings/seed/kanban-loop/`, but it is dormant: it is in no composition, nothing ticks it, and there is no board on disk. This brief takes it from dormant to running, adds the remaining lists and the board UI, completes the skill model, and wires the surfaces.

It builds on documents that must be read first. Where any of them disagrees with the current code, the code wins and the difference is flagged.

- `BRIEF/kanban-loop-wireframe-v4.html`. The visual and behavioral spec for the board, the lists, the run loop, the card, and the surfaces. This is the picture to build to.
- `BRIEF/kanban-loop-design-state.md`. The locked design decisions and the storage contract for V1a.
- `~/.garrison/kanban-loop/implementation-state.md`. The survey of what the engine, the model router, and the gateway actually do today.
- `~/.garrison/kanban-loop/autothing-skills-survey.md`. The survey of the autothing and garrison skill families and how each fits a list.
- `BRIEF-garrison-modes-fitting.md`. The source of the James voice and the brief-to-disk behavior the Discuss list relies on.

## What Kanban Loop is

A workflow state machine wearing a Kanban board. Cards are work items and the unit of truth. Lists are pipeline states. A list is either a manual column you move cards through by hand, or an agent list that runs one skill on a trigger. An agent list pairs an execute-prompt with a skill and a router-prompt, sends one run through the orchestrator, and the only thing the engine trusts back is the last non-empty line of the reply, which must exactly match one of the valid next-list names handed to it. Sessions are transient workers. The card carries links to everything a torn-down session needs to be reconstituted at the next list. It is a Garrison fitting of kind `automation-runner`; it composes the orchestrator, the skills, the scheduler, and the channels, and it does not become a runtime framework.

## Locked principles

1. One pattern, not parallel systems. A new concept fits the existing pattern rather than adding one.
2. The board is a sequencer, not a router. The orchestrator decides model and effort; the board sequences phases and delegates that decision.
3. PTY everywhere. No `claude -p`, no Agent SDK against the Anthropic endpoint.
4. The card is the unit of truth; sessions are transient.
5. Link, never duplicate. The card stores pointers; artifacts stay where they are produced.
6. Legibility. List configuration stays explicit and visible, so the system can be read through the composition view.
7. Fully responsive, phone-first. This is non-negotiable. Most of the value of this work is being able to drive it from a phone.

## The pipeline and the lists

Full per-list configuration, including the example cards and the routing, is in the v4 wireframe. The pipeline is:

`Backlog → To Do → Discuss → Plan → Implement → Review → Adversarial Review → Test → Adversarial Test → Walkthrough → Validate → Done`, plus the `needs-attention` parking lane.

- Backlog. Manual inbox. On entry, infer the title eagerly and the project only at 70 percent confidence or above, otherwise park in `needs-attention`.
- To Do. Manual, committed but not started.
- Discuss. Interactive only. The operative in James mode, through the web channel, produces a brief to disk. Advance is manual. See decision 8.
- Plan. `autothing-plan`. Classification `code, T2-deep`, mode James, trigger immediate. validNext `[Implement]`.
- Implement. `autothing-implement`, handed the plan slice, the acceptance, and the architecture doc. Classification `code, T2-deep`, mode Joe, trigger immediate. goalMode prepends `/goal <acceptance>`; the guard is the per-card iteration cap, not the goal-stop hook. validNext `[Review]`.
- Review. `autothing-review`, which wraps the `code-review` built-in. Classification `review, T1`, mode Joe, trigger immediate. validNext `[Adversarial Review, Implement]`.
- Adversarial Review. `autothing-adversarial-review`. A cross-model Codex pass through the `codex` CLI, not a higher tier. The operative is modest; the strength is Codex. validNext `[Test, Implement]`.
- Test. `autothing-test`, reading the repo's test commands. Classification `code, T1`, mode Joe. Trigger is a scheduler beat with its own cadence, for example five hours, not the global heartbeat. Batches by project: group the project's waiting cards, write one test plan, test them in one session. validNext per card `[Adversarial Test, Implement]`.
- Adversarial Test. `autothing-adversarial-test`. A cross-model Codex functional pass; needs a running dev server. validNext `[Walkthrough, Implement]`.
- Walkthrough. `autothing-walkthrough`, which wraps the real `walkthrough` skill. Records a verified video and links it onto the card. validNext `[Validate, Implement]`.
- Validate. `autothing-validate` (new verb, decision 2). Checks the Definition of Done, including the verified walkthrough video, and writes the durable gate markers. validNext `[Done, Implement]`.
- Done. Manual terminal column.
- needs-attention. Always notifies on entry. A card parks here on a low-confidence project, a non-matching verdict, an iteration-cap breach, or a run error.

Each agent list that fails ends its reply with `Implement`, and the card loops back.

## Decisions to implement

### 1. One skill family
Each agent list runs an `autothing-*` verb. The `garrison-*` shim skills retire, but only after parity is confirmed (see Verify first). The same verbs are usable from plain Claude Code sessions, not the board alone. Garrison's resources are reachable from any session through the install coupling, so the skills can rely on them directly.

### 2. New verb: autothing-validate
There is no generic governance verb today; the gate logic lives inside the autothing parent and the goal-stop hook, which the board does not run. Extract a standalone `autothing-validate` sub-skill from that logic. It reads the gate markers under the run directory, checks the Definition of Done including the verified walkthrough video, writes the durable gate markers, and ends with a parseable verdict the router-prompt can turn into a single next-list name. It must run standalone from a normal session, not only inside the board.

### 3. Doctrine rehoming
`garrison-architecture` is the one shim that carries real doctrine, the Vault surface pattern and the `src/lib` IO and surface-wiring rules, rather than just commands. Move that doctrine into a docs file the generic writer reads, for example `docs/architecture.md` or a section of `CLAUDE.md`. The other `garrison-*` skills only point generic verbs at the repo's commands and paths, which already live in the repo.

### 4. Each pass is its own list
The two cross-model Codex passes are their own lists, Adversarial Review after Review and Adversarial Test after Test, because the skills are already separate and a separate list makes each pass a visible run with its own log and card movement.

### 5. Per-card runId, plus agent_mail and beads
Concurrency splits into two concerns. Concurrent code editing across cards is kept safe by the existing `agent_mail` MCP, sessions claiming files with notes before editing, and `beads`, keeping sessions aware of each other. Artifact paths are kept apart by the autothing skills' native per-run directories: the engine mints one runId per card on its first agent-list entry and threads the run directory into every subsequent execute-prompt, so each card's plan and gate files do not collide. Full concurrency, no per-project serialization.

### 6. Gateway hint honored in both modes
The classification hint the board attaches is honored in the PTY gateway path but dropped in the souls path. Target the path that honors it, and add a small fix so the hint is honored in both gateway modes, so the board is not silently broken by adding a composition that switches modes.

### 7. Convergence is the iteration cap
Prepending `/goal` is prompt text only. The autothing goal loop never fires for a board run, because its sentinel is written only by the autothing parent and the board runs on the shared operative. The per-card iteration cap plus the loop-back edges is the convergence guard.

### 8. Discuss is James mode plus brief-to-disk
Discuss needs no new skill. It is the operative in James mode, the modes fitting, holding an interactive conversation through the web channel and writing a brief to disk under `briefs_path`. The advance is manual. Auto-infer of the brief is deferred until there have been enough real interactive conversations to decide what an automatic version should do.

### 9. The web channel as the one chat surface
Grow the web channel into the one context-driven chat surface, used by Dev Env, the Kanban, and standalone. It must be fully responsive, support read-aloud of the spoken replies, and render or link the produced documents. It runs Discuss in James mode. Keep it generic: fittings hand it context, a card, a Dev Env session, or nothing, and it adapts; it does not learn about them. Leave the operative test interface untouched.

### 10. Link, never duplicate
The card stores pointers, not copies. The plan is a file under the run directory; the brief is a file under `briefs_path`; each run's session is a Claude Code transcript referenced by id; the gate markers and Codex round files are under the run directory; the screenshots stay where produced; the video is a link to the walkthrough gallery. Add server-side machinery to serve those files where needed. New card fields are `runId`, `runDir`, `sliceId`, `sessionIds[]`, `briefPath`, `videoUrl`, with no migration, since storage is file-per-card JSON.

### 11. Fully responsive, phone-first
The board UI must work from a phone. This is a hard requirement, not a finishing touch.

## Engine changes, fittings/seed/kanban-loop

- Populate the three triggers on the seed lists. Today the lists carry no trigger field, so everything behaves as immediate. Set `immediate`, `scheduler beat`, or `manual` per the pipeline above.
- Wire the scheduler beat for Test at setup time, with its own configurable cadence, following the existing scheduler-registration pattern. The global heartbeat is not used.
- Implement Test batching: gather the project's waiting cards, run one session per project against one test plan, and emit a per-card verdict.
- Mint a runId per card on its first agent-list entry and thread the run directory into each execute-prompt, so the autothing skills write per-run.
- Add the new lists to the seed board with their skills, classifications, validNext edges, and triggers: Discuss, Adversarial Review, Adversarial Test, Walkthrough, Validate.
- Confirm the per-card iteration cap default and keep it as the convergence guard.
- Install the fitting into a composition and ensure something ticks it.

## The board UI, V1b

Build to the v4 wireframe. Fully responsive. The card front is minimal: Start or Advance, Move, Watch, Open. The card detail shows the links in decision 10 plus the small decision log. The Watch button attaches to a live run, opens the web chat on an interactive list, or shows the linked logs when nothing is live. Moving a card by hand is the manual gate. Discuss opens the web channel chat.

## Verify first, resolve before committing the slice plan

These can change the plan, so confirm them in the planning phase.

- That `autothing-implement` reads Garrison's conventions from docs as well as it does when handed the area skill. Test this on one slice before retiring any `garrison-*` skill. If it needs the area skill handed in, the doctrine-rehoming approach changes.
- Where the `walkthrough` skill writes its video, so the card can link it.
- The Claude Code session transcript path under `~/.claude`, since the card links to it.
- That the operative and Dev Env PTYs are tmux-attachable, for the Watch button.
- That `autothing-validate` and the other verbs honor a passed-in run directory.

## Suggested workstreams, planning guidance

Group the work so slices are coherent: the verify-first investigations; the new `autothing-validate` verb and the doctrine rehoming; the engine changes, triggers, scheduler beat, batching, runId threading, new lists; the gateway hint fix; the board UI; the web channel work and the Discuss wiring. Let the planning phase finalize the slices.

## Out of scope and deferred

- Auto-infer of the Discuss brief.
- A board-wide Codex serialization lock; two adversarial passes colliding is judged unlikely, and a lock is the fix if it ever bites.
- Autothing-as-a-preset, a dedicated session running the whole autothing skill for true per-card convergence.
- Batch execution beyond the Test list.
- Rich-media notifications; V1 sends a link to the card.
- List create, read, update, delete in the UI; V1 board configuration is hand-edited.

## Acceptance criteria

Print each as a numbered FINDING line so it can be checked from the transcript.

1. FINDING 1. The kanban-loop fitting is installed in a composition and a scheduler job ticks it. Print the composition dependency and the scheduler job.
2. FINDING 2. The seed board has the full pipeline with triggers populated. Print each list with its kind, trigger, skill, classification, and validNext.
3. FINDING 3. A card dropped in Backlog infers a title; the project is applied only at 70 percent or above, otherwise the card parks in needs-attention. Show a parked low-confidence card.
4. FINDING 4. Pressing Start sends a card to Plan, the engine mints a runId, `autothing-plan` writes FLOW_PLAN under the run directory, and the card auto-moves to Implement. Print the runId and the per-run FLOW_PLAN path on the card.
5. FINDING 5. Each agent list ends its reply with exactly one valid next-list name. Show a Review pass moving to Adversarial Review and a Review fail moving to Implement.
6. FINDING 6. The adversarial lists run cross-model through the `codex` CLI, not a higher tier. Print a CODEX CALL line from Adversarial Review.
7. FINDING 7. Test batches by project: several cards tested in one session per project on the scheduler beat. Show the batched run.
8. FINDING 8. Walkthrough records a verified video and the card links it. Print the video link and the card's `videoUrl`.
9. FINDING 9. `autothing-validate` runs standalone on a slice, checks the Definition of Done including the video, and ends with a parseable verdict. Show it returning Done, and separately Implement on a failing slice.
10. FINDING 10. The card stores links and pointers, not copies. Print a `card.json` with `runId`, `runDir`, `sliceId`, `sessionIds`, `briefPath`, `videoUrl`, and no inlined document bodies.
11. FINDING 11. The classification hint is honored in both gateway modes. Show routing resolving correctly with the souls or mcp-gateway stack present.
12. FINDING 12. The board UI is fully responsive. Show it at a phone width with the lists and a card's links.
13. FINDING 13. Discuss opens the web channel chat in James mode, produces a brief on disk, and links it from the card, with a manual advance. Show the brief path and the link.
14. FINDING 14. The web channel renders or links a produced document and offers read-aloud, and the operative test interface is unchanged.
15. FINDING 15. The `garrison-*` shims are retired only after `autothing-*` parity is confirmed on one slice. Print the parity result.

End with the literal final stdout line:

```
KANBAN-LOOP-V1B OK
```
