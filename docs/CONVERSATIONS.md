# Garrison Conversations Architecture

Garrison Conversations is the multi-turn, stretch-scoped conversation substrate that replaces per-run session logs with durable conversation identity. One conversation = one card lifetime. Every model turn is a **stretch** (a fresh session, a brief handoff in, structured evidence handoff out, and an exit gate that verifies readiness).

## The Conversation Store (Three Layers)

Store location: `$GARRISON_HOME/conversations/<conversation-id>/`

### L1 — Summary (Human-Facing)
**File**: `summary.md` (one page, ~6000 bytes, ~80 lines)

Five fixed sections, written by the exit gate on each stretch completion:
- **Objective** — what this conversation is working toward (from the initial brief or updated at key decision points)
- **Current state** — where the work stands (brief bullets, not a log)
- **Decisions** — key choices made and their reasoning
- **Active constraints** — blockers, dependencies, escalation floor
- **Your duty** — the next working duty and level (triage → implement → test → review → done, etc.)

The summary serves as the one-page resumption point: a contributor can read it cold and understand the conversation's trajectory, where it stalled, and what comes next. It is **never** a transcript.

### L2 — Handoffs (Structured Exits)
**Directory**: `handoffs/` (ordinal JSON files: `0001.json`, `0002.json`, …)

One file per completed stretch. Schema:
```json
{
  "v": 1,
  "stretchId": "<the stretch identifier>",
  "duty": "<triage|implement|test|review|…>",
  "status": "complete|partial|blocked|failed",
  "summary": "<≤4000 chars: what happened, decisions made>",
  "evidenceRefs": [
    {"kind": "file|commit|run|gate|artifact|url|log", "ref": "<path|id>", "note": "…"}
  ],
  "nextSteps": {
    "next": "<duty name or done>",
    "why": "<reason for this transition>",
    "items": ["checklist item 1", "item 2"]
  },
  "blocker": null | {"what": "…", "needs": "…", "who": "…"},
  "activeConstraints": ["constraint 1", "…"],
  "failedApproaches": [{"approach": "…", "why": "…"}],
  "surprises": ["unexpected finding"],
  "forceEscalation": null | "<reason>"
}
```

The handoff packet is the **contract between stretches**: the successor reads it to understand what was attempted, what worked, what failed, and what evidence exists. It is immutable once written — stretch N cannot rewrite stretch N-1's handoff.

### L3 — Ledger (Observation-Only)
**File**: `log.jsonl` (append-only, multi-process safe via O_APPEND)

Event kinds (extensible vocabulary — unknown kinds are stored verbatim):
- `conversation-opened` — the conversation's first stretch started
- `stretch-started` — a new stretch launched (duty, level resolved)
- `stretch-ended` — a stretch completed (reason: done, failed, blocked)
- `handoff` — the exit gate wrote the handoff packet
- `delegation-dispatched` / `delegation-returned` / `delegation-failed` — secondar y runtime work
- `user-message` — user input from chat, voice, or other channels; `disposition` says what became of it (`opened` a responder, `queued` behind a running stretch, `steer` — it interrupted the running stretch), `delivery` the mode the sender asked for
- `stretch-steered` — a user message interrupted the stretch in flight; the same duty re-runs with the message in its brief
- `card-materialized` — a done card spawned from this conversation
- `card-state-changed` — the card moved between lists
- `policy-rewrite` — routing policy or composition changed mid-conversation
- `escalation` — duty or level escalated
- `summary-trimmed` — summary rebuilt to fit caps
- `dig` — reader (web-channel, drill) accessed the conversation

**Payloads directory** (`payloads/`): Large payloads (>64 KB) spill to content-addressed JSON files with verifiable SHA-256 pointers. Never truncated.

**Log rolling** (`log.<ms>.jsonl`): At 64 MB, the active log rolls into an immutable segment. Readers scan segments in chronological order; no data is ever dropped.

---

## The Stretch Lifecycle

A stretch is **one working session**, bounded by a handoff:

1. **Brief In** — gateway receives the request, mint a `conversationId` (ULID), record `stretch-started` with the classified duty + level, resolve the cwd (via card.project → @personal), pass the conversation ID and current summary through the composed system prompt

2. **Work** — the operative runs until terminal state (done, blocked, failed, escalated). Multiple model turns within a stretch share the same conversation context. The ledger records events: user messages, delegations, policy rewrites

   **Steering mid-stretch.** `POST /conversation/message` takes a `delivery` field for a conversation that is WORKING: `steer` (the card composer's default) records the message, then interrupts the stretch in flight through the same stop primitive a cancel uses; `queue` (the door's default) holds it for the next brief. A steered stretch skips the exit gate — no re-ask, no repair, no `needs-input` — and leaves a synthetic `partial` handoff marked `steered: true` that routes straight back to the SAME duty, whose next brief carries the message. The tripwires and the attempt counter skip steered handoffs (an interruption is neither progress nor its lack), and the card stays on Running throughout. A cancel still stops the whole conversation: the stretch's own controller is chained to the conversation's.

3. **Exit Gate** — the operative's gateway exit-gate resolver:
   - Validates terminal state + gate markers exist under `runDir`
   - Composes the structured handoff from duty summaries, gate markers, brief decisions, touched files, and evidence manifest
   - **Writes** `handoffs/<ordinal>.json` (immutable)
   - **Rewrites** `summary.md` with the new state and next duty
   - Records `handoff` + `summary-trimmed` events
   - Releases the card's `.current-stretch` lock

4. **Recovery** — on gateway restart or card re-entry:
   - The board's tick calls `/conversation/kick` (409-idempotent) to resume where the operative left
   - The gateway reads the latest summary.md + the tail of log.jsonl to rebuild context
   - The successor stretch continues from the last handoff

---

## Duty Ladders and Rungs

Each duty has **three levels** (floor → middle → top), each with its own model, effort, and runtime target. A card's **rail** is its duty sequence (e.g., triage → plan → implement → test → review → done). A **rung** is the level at which a duty runs.

### Duty Expansion
- **Composite duty** (e.g., `develop`) expands to sub-duties: plan → implement → test → review
- **Leaf duty** (e.g., `implement` in the `develop` sequence) expands to itself — one step at its own level
- A per-duty level (card.dutyLevels[implement]) overrides the card's base level for that duty only

### Adversarial Cross-Rung
When a change is contentious, escalate to a **second opinion rung**: the same duty runs twice at different levels (e.g., floor-confidence `implement` followed by top-tier `adversarial-review`), and the two verdicts must align or the work loops back.

---

## Five-State Board & Recovery

The list **IS** the state — a card's `status` is re-derived from `list` at write time (`coherentCardState`). Always **move** a card between lists; never flip `status` in place, or the write becomes a silent no-op.

### Lifecycle at a Glance

| List | Entry condition | State driver | Exit condition |
| --- | --- | --- | --- |
| **To Do** | card created, or scheduler/human releases it back from Scheduled, Needs Attention, or Done; a due `scheduleAction: "run"` occurrence materializes straight here carrying that action | `list: "todo"`; no active stretch — a resume that routes to `responder` moves the card to Running for the responder's own stretch, like any other | Start posts `/conversation/kick` when the card has no `conversationId` yet, `/conversation/message` to resume when it does; a settled done/needs-input handoff routes the resume to `responder` first, and the card is on Running while the responder works: it settles back to Done after a question, to Needs Attention when it is still parked, or stays Running when the responder hands a follow-up ask to a working duty (2026-09-03; the responder used to reply without moving the card); a card left sitting here with `scheduleAction: "run"` is instead picked up by the tick's own kick pass on a later beat; a human can also Move the card straight to Needs Attention, or Mark done/Move it to Done — evidence-gated for a conversation-linked card (revisit and rescue moves preserve the same `conversationId`) and free only for a fresh/unlinked card |
| **Running** | any stretch begins, the responder's included — via Start's kick/message, a message typed into the card's conversation, the tick's separate kick of a due schedule run, or the tick re-kicking a card already stuck here to recover it (idempotent — the gateway 409s an already-advancing conversation) | engine-owned; exactly one active stretch at a time | exit gate resolves: `nextSteps.next === "done"` → `writeCardTransition` attempts the Done PATCH, but `writeCardWithHooks` refuses it unless the handoff carries a resolvable gate/run/file ref or a `completionOverride` — refusal leaves the card Running with a terminal handoff that a later kick cannot repair — `nextDutyFor` reads the same terminal handoff and `runConversation` exits at its pre-stretch terminal check without retrying the card write, so recovery needs a separate qualifying transition or a code fix; `next === "needs-input"` or a stretch error → Needs Attention (the stretch cap parks the same way); another duty → stays Running for the next stretch; at the final allowed stretch the numeric loop bound is checked before that terminal `next` is observed, so the cap patch can still overwrite an already-successful done/needs-input transition with a cap park — but it leaves the terminal handoff itself intact; the server also accepts a narrow human rescue PATCH moving a wedged card to any list but Running or Scheduled — including Done, which stays evidence-gated — though the UI hides Move while a stretch owns it |
| **Needs Attention** | the exit gate parks on `needs-input`, a stretch error, or the per-conversation stretch cap; `forceEscalation` shapes the rung the NEXT resumed stretch runs at, while `blocker` only supplies the parked `attentionReason` text — neither alone moves the card | held for human steering; `recoverInterruptedRuns` and `isOrphanedRun` both skip any card with a `conversationId`, so it is never auto-swept | human steers via Start, which posts `/conversation/message`: when the latest handoff's `next` is terminal (`done`/`needs-input`) it routes to `responder` first, which moves the card to Running while it answers and back here if the conversation is still parked — or on to the duty the message asked for; an ordinary stretch-cap park leaves that `next` untouched, so Start resumes the same non-terminal duty directly and the card moves straight to Running — except a cap park at the final allowed stretch after an already-successful done/needs-input handoff, where that terminal `next` survives and Start instead routes to responder; a human can instead Move the card directly to To Do or straight to Done (the latter still evidence-gated) without resuming it; an idle Steer "revisit" action re-stages the card to To Do and, when it carries a message, forwards it to `/conversation/message` immediately; `/conversation/kick` is used only for a fresh start or by the tick, for both its recovery lane and its due-schedule-run lane |
| **Scheduled** | card holds a future date or cron schedule | dormant until the schedule fires, the explicit `/cards/:id/run-now` action acts before that instant, or a human clears `schedule`/`scheduledFor` (refused while the card is running) — a paused recurring template does neither and only Run now can still exercise it | a one-shot occurrence releases the original card itself — to `schedule.targetList` on `notify`, or to To Do carrying `scheduleAction: "run"` so the tick kicks it; a recurring cron template instead materializes a brand-new occurrence card at that same destination on every firing while the template itself stays in Scheduled with `nextAt` advanced to the following occurrence; explicit Run now instead pulls a one-shot's `nextAt` to now and releases it immediately via `sweepDueSchedules`, or for cron creates one extra runnable occurrence while the template stays Scheduled with its regular `nextAt` unchanged; clearing the schedule instead returns the card immediately to its stored `schedule.targetList` (falling back to To Do) with the scheduling fields wiped |
| **Done** | handoff's `nextSteps.next === "done"` moves the card here through the exit gate; a card with no `conversationId` can also be moved here directly by a human Mark done/Move, owing no evidence | terminal; a conversation-linked card entering Done is evidence-gated — the write is refused unless the latest handoff is `complete` with a resolvable gate/run/file ref, or the card carries a `completionOverride` (recorded as an unproven pass, never a silent one); the plain UI Mark done/Move supplies no new override, so it can only complete a conversation-linked card via an already-qualifying handoff or an already-stored `completionOverride`, reusing whichever is present rather than writing a new one | an idle Steer "revisit" action re-stages the SAME card (same `conversationId`) to To Do and, when it carries a message, forwards it to `/conversation/message` immediately; a plain human Move to To Do only re-stages the card — Start must still be pressed to resume it via `/conversation/message`; absent either, Continue creates a successor card that lands on To Do — its attempted PATCH to a "plan" list 400s against the five-state board and is silently swallowed — whose OWN fresh conversation begins only once that successor is started; a human can also Move a Done card straight to Needs Attention |

### Evidence Resolution in the Exit Gate
The stretch's working cwd (resolved from card.project → @personal via `resolveRunScope`) must also reach `resolveEvidence` in the exit gate, or every project stretch's handoff gets rejected into the repair loop. Degraded resolution (project named but absent on this node) records a ledger event, never silent.

---

## Store Discipline

- **Multi-process safety**: Four processes append to the ledger (gateway launcher, board server, web-channel server, codex bridge). One `appendFileSync` per record ensures O_APPEND atomicity; concurrent writes interleave between records, never within one.

- **Order is line order**: The `seq` field (per-writer counter) is diagnostics only. The stable coordinate is `index` (line number), assigned at read time by scanning segments.

- **Write guard** (`.current-stretch`): Only the active stretch can write the summary; the file is the CAS lock. The exit gate releases it by writing the handoff.

- **Content-addressed payloads**: Same large payload appearing twice produces identical `spilled` references (SHA-256), so readers can deduplicate.

---

## Implementing a Duty

When authoring a new duty or level:

1. Add the duty to the Orchestrator's `duties` registry (YAML in `composed system prompt`)
2. Declare the level's `target` (runtime engine), `model`, and `effort`
3. The gateway's ruleId will match the (duty, level) cell that actually executed
4. Compose a structured handoff at the duty's gate, naming the phase, summary, decisions, and constraints
5. Write the exit gate's logic to check for the required gate markers under `runDir`

The card's handoff packet feeds the next duty's context. Chain them cleanly: each duty's summary is the successor's brief.
