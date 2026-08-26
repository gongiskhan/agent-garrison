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
- `user-message` — user input from chat, voice, or other channels
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

### Board States
- **To Do** — ready to start (initial list)
- **Running** — an engine-owned card; exactly one stretch is active
- **Needs Attention** — blocked, stalled, or requires human steering (escalation, approval gate pending)
- **Scheduled** — held by a future date + cron schedule
- **Done** — terminal state; handoff written; generates handoff packet for the successor

### Release-Path Bug Class
The list **IS** the state: a card moved to `done` must have `list: "done"`. Code that flips `status` while leaving `list: "running"` creates a silent no-op (coherentCardState re-derives status from list at write time). Always **move** the card; never change status in place.

### Conversation Cards Never Swept
The tick's `recoverInterruptedRuns` returns `null` for any card with a `conversationId` — they never get auto-released. Their recovery is the 409-idempotent `/conversation/kick` endpoint, which the gateway drives.

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
