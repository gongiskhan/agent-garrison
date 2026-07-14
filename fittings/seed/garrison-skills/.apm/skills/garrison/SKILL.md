---
name: garrison
description: Autonomously implement a SIGNIFICANT piece of software work end-to-end and prove it with self-verified evidence — a new feature, page, module, service, or endpoint, a behavior change or multi-file refactor, OR a whole new app. ANY size of significant code work, NOT only whole projects; web and non-web (browser walkthrough for web, asciinema for CLI/TUI). THE THIN DOORWAY into the Garrison Orchestrator (GARRISON-UNIFY-V1 D13) — it registers the run as a card on the Kanban board and drives it through the run engine's gated phase pipeline; the orchestration doctrine itself lives in the merged Orchestrator prompt and the compiled policy, not here. Triggers on "implement/build/add X", "ship this feature", "refactor X", "build this project", or a resume ("--resume", "resume the run", "continue the garrison run", "pick up where it left off"). An EXPLICIT invocation ALWAYS runs — it scales via the policy's work kinds, never refusing. AUTO-invocation is SOFTWARE-ONLY: the model may self-trigger garrison ONLY when BOTH (a) the task implements or changes RUNNABLE SOFTWARE in a code project — primarily JS/TS/Node web apps and services, also Python — verifiable by build/tests/running the app; AND (b) it is NOT prose, documentation, markdown, configuration, data files, or Claude skills/agent instructions. The Do-NOT auto-trigger list (scope of AUTO-invocation ONLY, never a refusal list): bug fixes, one-line or small edits, single-function tweaks, formatting/renames, running the app, tests alone, or pure research.
---

# garrison — the thin doorway

garrison is a DOORWAY, not a brain. The orchestration doctrine (the phase
pipeline, the retry ceilings, fix-forward, the honesty rules, the
durable-markers contract, coordination duties) lives in the merged
Orchestrator prompt; every routing knob (task
types, models, efforts, runtimes, phase plans, work kinds, phase-skill
bindings) lives in the compiled Orchestrator policy. This skill only performs
the mechanical entry steps below, then drives the run through the run-engine
library so the Kanban board shows it live — identical in shape whether the run
started from chat, the board, or this skill.

## Step 1 — read the compiled policy (hard requirement, D5)

Read `~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`). If
the file is missing or unreadable, STOP IMMEDIATELY and print exactly:

> Garrison Orchestrator policy not found at ~/.garrison/orchestrator/policy.json. Start Garrison; garrison does not run standalone.

No env-var override, no embedded default, no fallback model choice. The policy
is the single authority for every phase's skill, model, effort, and runtime.

## Step 2 — register the run as a card in Plan

Parse the invocation: the brief (everything that is not a flag), an optional
`--kind <workKind>` (else the policy's `defaultWorkKind`), and per-phase
toggles (`--no-<phase>` for any phase in the policy's `phases` list, e.g.
`--no-walkthrough` → `phases: {"walkthrough": false}`). Then register via the
board API (discover it from `~/.garrison/ui-fittings/kanban-loop.json`; never
hardcode a port):

1. `POST <board>/cards` with `{description: <brief>, goalMode: true,
   workKind, phases, tier, origin: "garrison-doorway",
   origin_id: "skill:<$CLAUDE_CODE_SESSION_ID>", project: <cwd repo>}`. Stamp
   `origin_id` as `skill:<your session id>` (use `$CLAUDE_CODE_SESSION_ID`, the
   stable id this session already uses for its sentinel; mint one only if it is
   unset) - that origin_id is what makes this run's lifecycle + duty-summary
   events pollable.
2. `PATCH <board>/cards/<id>` with `{list: "plan", rev}` and the
   `x-garrison-engine: garrison-doorway` header.
3. Tell the user the card URL (`<board>/#/cards/<id>`). The board is now the
   window on this run.

If the board is unreachable, that is a blocker with a named cause — do NOT
fall back to a boardless run (the board is the run's window; a run without a
card is invisible).

Because a skill session has no push surface (unlike a web thread), pull the
run's lifecycle updates via the `poll_origin_events` MCP tool (garrison-control):
`poll_origin_events {origin_id: "skill:<your session id>", since?}` returns the
same created | needs-input | blocked | failed | finished | duty-summary events a
web thread receives - poll again with the returned `next_since` for only new
events. This is the skill/terminal parity path (S3e).

## Step 3 — drive the run in THIS session through the run engine

The run engine is a library (`fittings/seed/kanban-loop/lib/engine.mjs`,
installed under the composition's `apm_modules/_local/kanban-loop/`). For each
phase of the card's rail, in order:

1. Arm the per-phase goal loop: write the per-session sentinel
   (`~/.garrison/sentinels/$CLAUDE_CODE_SESSION_ID.json`) with the condition
   "loop until this phase's `GATE <phase>:` line prints" — the Stop hook
   (`hooks/garrison-goal-stop.sh`, wired by `hooks/install.sh`) keeps the
   session taking turns until the phase's gate line prints. The hook owns
   liveness WITHIN a phase; the board owns progression BETWEEN phases.
2. Execute the phase through its policy-bound skill (the card's rail names
   it; the skill reads the policy for its own model/effort per the bindable
   phase-skill contract). The skill writes the phase's gate-status entry
   under the card's runDir and prints its `GATE <phase>: <verdict>` line.
3. Advance the card in-process: call the engine's `advanceCardPhase({root,
   board, card, verdict})` — it enforces the same contract as the dispatched
   path (valid verdict + the phase's durable gate evidence + the rail's
   on/off fast-forward) and moves the card. A refusal (missing gate evidence)
   means the phase is NOT done — loop back into the phase, never bypass.
4. Update the sentinel for the next phase and continue until the card reaches
   `done` (or parks in `needs-attention` with an honest reason).

The run survives session death: the card + its runDir are the durable state;
any resumable card re-dispatches from the board (`--resume` = find the card,
continue at its current list).

## Hooks (mechanical)

`hooks/install.sh` (idempotent) wires `hooks/garrison-goal-stop.sh` (Stop) +
`hooks/garrison-goal-sessionstart.sh` (SessionStart) into
`~/.claude/settings.json`; `hooks/probe.sh` is the liveness probe. Run the
installer once at entry; if it reports `installed/repaired`, this session needs
a one-time `/goal` (a fresh hook activates next session).

The goal hooks are transition-safe across the autothing→garrison rename: new
runs arm sentinels under `~/.garrison/sentinels/`, but the hooks honor BOTH
`~/.garrison/sentinels/` and the legacy `~/.autothing/sentinels/` (and both
verdict grammars) so an in-flight legacy run keeps looping until it finishes.
The installer is additive and never removes a legacy autothing hook entry.

**`hooks/prune-legacy.sh` is the other half of that transition** — the step that
retires the legacy hooks once no legacy run can still be looping. It is gated,
not unconditional: it REFUSES (exit 3) while any sentinel remains under
`~/.autothing/sentinels/`, and when the gate is clear it removes exactly the
legacy autothing Stop + SessionStart entries from `~/.claude/settings.json`
(backing the file up first), leaves the garrison entries untouched, and is
idempotent. `--check` reports without writing; `--remove-skill-dir` also deletes
the retired `~/.claude/skills/autothing/` doorway. Run it after the last legacy
run ends — that is the only moment the gate opens.
