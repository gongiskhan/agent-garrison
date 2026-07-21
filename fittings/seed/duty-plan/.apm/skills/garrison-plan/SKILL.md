---
name: garrison-plan
description: Reproduce Claude Code plan mode autonomously - explore the request and codebase with read-only Explore subagents, design with Plan subagents, then write a concise, durable implementation plan file. Does NOT call native EnterPlanMode/ExitPlanMode (they fail in agent and auto contexts) and never mutates the system except the plan file. This is the planning step of a Garrison run, distinct from garrison-implement (writing code) and garrison-test (verifying it). Invoked by the Garrison run engine as its planning step, or standalone only when the user explicitly asks for it. Do NOT auto-invoke this skill from task inference - Garrison decides when its phase skills run.
---

# garrison-plan

## Policy-read preamble (soft - D5/D12)

At the start of every invocation, look for the compiled Orchestrator policy at
`~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`).

- **Policy present** (a Garrison run): it is the single authority. This skill
  carries NO model/effort pins - its execution parameters come from the policy
  matrix cell for its phase (`matrix[<phase>][<tier>]`), and its gate duties
  from the bindable phase-skill contract (the Orchestrator fitting's
  PHASE_SKILL_CONTRACT.md): do the phase's work in the run context handed to you
  (runDir, card, phase), write the phase's gate-status entry under the runDir,
  and print the phase's `GATE <phase>: <verdict>` line before choosing the next
  list.
- **Policy absent** (standalone, any repo): proceed with the caller-supplied
  context and sensible defaults - NEVER stop. Report to the caller rather than
  writing gate-status/run artifacts, and skip any board/run-engine steps.


Reproduces the **exploration + planning quality** of Claude Code's native plan mode without using the native plan-mode tools. Native plan mode cannot be driven autonomously — `EnterPlanMode` throws in agent/subagent contexts and `ExitPlanMode` always raises a human approval dialog — so this skill copies plan mode's *prompts and read-only discipline* instead, and produces a durable plan file a build phase can execute.

**Hard prohibition (the skill's whole reason to exist):** NEVER call `EnterPlanMode` or `ExitPlanMode`, and NEVER spawn `claude -p` or the Agent SDK against Anthropic endpoints. The verbatim plan-mode prompts this skill embeds are in `references/plan-mode-prompts.md` — read that file before Phase 1; it is the authoritative source of the discipline and the subagent system prompts.

## The binding read-only rule (paraphrased from the plan-mode system-reminder, block A2)

Planning mode is active. Do NOT make any edits, run any non-read-only tools (including changing configs or making commits), or otherwise change the system — **with the single exception of the plan file**. This supersedes any other instruction to make edits. Research comprehensively, write the plan to the plan file, then hand it to the gate. Make no file changes and run no system-modifying tools until the plan is approved by the gate (in garrison's autonomous context, "approval" is garrison's own sequencing gate — see Phase 5).

A skill cannot truly gate tools, so treat this as an absolute behavioral contract: until the plan is handed off, the plan file is the ONLY thing you may write — plus, **only when garrison invokes it**, this run's spec + control-plane records (`RUN_SPEC.md`, the sentinel `turnCap`, `gatesConfig`, and RUN_LOG entries — planning's own output under `<runDir>` + the per-session sentinel, **never target source**; see "Run-shaping when invoked by garrison").

## Autonomous adaptation (when invoked by garrison or in any auto/unattended context)

Native plan mode uses `AskUserQuestion` to clarify ambiguities. **In an autonomous context, do NOT ask — resolve each open question with a recommended answer and record the assumption in the plan** (for garrison runs, in the RUN_SPEC assumptions ledger). The operator prefers Claude to make the call and proceed. (When a human is genuinely driving this skill interactively and a choice is truly load-bearing, `AskUserQuestion` is still permitted — but default to deciding.) The one operator-authorized exception is `--ask-questions` (default OFF): it permits exactly ONE pause, AFTER `RUN_SPEC.md` is written, and never any other pause — see "Run-shaping when invoked by garrison".

## The plan file (durable — never plan only in context)

Workflow/subagent intermediate state lives in script variables and only a final result returns to context, so the plan MUST be a durable file the build phase and the resume scan can re-read. **Never a shared, fixed path** — concurrent plan/build runs in other sessions must not clobber each other.
- **Caller-supplied path wins.** When garrison invokes this skill it passes a **per-run** path — `docs/autothing/runs/<runId>/FLOW_PLAN.md` in the target repo. Write exactly there (never a shared `docs/FLOW_PLAN.md`), following the FLOW_PLAN slice-table shape garrison expects (`assets/docs/FLOW_PLAN.md` in the garrison skill).
- **Standalone default:** mirror native plan-mode semantics but make the path **unique** — write to `~/.claude/plans/<slug>-<YYYYMMDD-HHMMSS>.md` (slug = short kebab summary; the timestamp keeps concurrent standalone plans from colliding). Create with Write; make incremental edits with Edit.
- This plan file is the ONLY file you may create or edit during planning — **plus, when garrison invokes it, this run's spec + control-plane records**: `<runDir>/RUN_SPEC.md` and the sizing-derived writes to the sentinel `turnCap` / `gatesConfig` / `RUN_LOG` (see "Run-shaping when invoked by garrison"). Those are planning's own durable output under `<runDir>` + the per-session sentinel — **never target source**; the codebase stays read-only (no source edits, no commits). Standalone, the plan file is the only writable artifact.

## The 5-phase workflow

Read `references/plan-mode-prompts.md` first. Then:

### Phase 0 — Acquire the planning gate (advisory; only when coord-mcp is present)
If the **coord-mcp** planning-gate tools are available (the Garrison coord stack is connected), call `begin_planning(repo, summary)` BEFORE exploring — coord-mcp serializes planning so only one session plans a repo at a time:
- **GRANTED** → read the returned read-bundle (the last released plan + recent plans + in-flight intents/decisions) and fold it into your plan, so you build on other sessions' context instead of planning blind. Hold the lock through Phases 1–4; `plan_heartbeat` if planning runs long.
- **WAIT** → another session is planning this repo. Honor the bounded wait and re-check; if you are autonomous and cannot acquire within budget, **park the task and surface it — never hang.**
- Call `end_planning(repo)` once the plan file is written (Phase 4), so the next planner inherits your summary.

If the coord tools are absent (no Garrison, or the MCP is not connected — including this kind of direct session), **skip this entirely and plan as normal; never hard-block on it.** This is what makes garrison-plan compose with coord-mcp's "one planner per repo at a time" guarantee.

### Phase 1 — Initial Understanding (Explore subagents ONLY)
Gain a comprehensive understanding of the request and the code it touches.
- **Launch 1–3 `Explore` subagents IN PARALLEL** (single message, multiple Agent tool calls, `subagent_type: "Explore"` — Haiku, context-isolated, cheap). Use **1** agent when scope is isolated to known files; **multiple** when scope is uncertain, several areas are involved, or you must learn existing patterns before planning. **Quality over quantity — usually just 1.** Give each agent a **specific search focus** and a thoroughness hint (`quick | medium | very thorough`).
- The built-in `Explore` agent already runs the block-A4 system prompt; embedding it in `references/plan-mode-prompts.md` preserves the behavior if you ever must run the prompt inline (e.g. the built-in agent is unavailable).
- After exploring, **resolve ambiguities with recommended answers** (autonomous rule above) rather than asking.

### Phase 2 — Design (Plan subagents)
Launch `Plan` subagent(s) (`subagent_type: "Plan"`, inherit the main model) to design the implementation from Phase-1 findings. **Pass comprehensive context** — filenames, code-path traces, the patterns Phase 1 found. The Plan subagent runs the block-A5 system prompt (architect; read-only; ends with a "Critical Files for Implementation" list).

### Phase 3 — Review
Read the critical files the agents identified to deepen understanding; ensure the design aligns with the original request; **resolve any remaining questions by deciding** (not asking).

### Phase 4 — Write the final plan
Write the final plan to the plan file. **Recommended approach only — not every alternative.** Concise enough to scan, detailed enough to execute. Include the **paths of critical files to modify** and the **verification steps / success criteria**.
- **Keep it short.** Production data: plan files p50 ≈ 4,906 chars, p90 ≈ 11,617; rejection rises with length (under 2K ≈ 20% rejected, over 20K ≈ 50%). **Target a few thousand characters; hard-cap if it grows past ~12K** — move detail into the build, not the plan.
- **When garrison invokes this — spec-first + slice sizing.** For significant runs (**above ~3 slices**) write `<runDir>/RUN_SPEC.md` FIRST and DERIVE the FLOW_PLAN slice table from it; **split any slice sized > ~8** (of the 100-point sizing) into gated sub-slices. Then apply the sizing-derived control-plane writes — profile, `turnCap`, `deliberateRed`/`mutation` defaults — and, if `--ask-questions` is set, take the one operator pause. All of this is detailed in "Run-shaping when invoked by garrison" below.

### Phase 5 — Gate (stand-in for ExitPlanMode — NEVER call ExitPlanMode)
The plan is now written to the plan file. **Hand it to garrison's approval/sequencing gate** instead of calling `ExitPlanMode`:
- When invoked by garrison: return control; garrison reads the plan file and proceeds to bootstrap + the build loop. State, in your final message, the plan-file path and a one-line summary (the plan content lives in the file, not the message — mirroring ExitPlanMode semantics, block A7).
- When standalone: announce the plan-file path and that planning is complete; let the human drive execution. Do not ask "is this plan okay?" — writing the file + announcing it IS the handoff.
- **If you acquired the planning gate in Phase 0, call `end_planning(repo)` now** — release the lock so the next session can plan and inherit your summary.

## Run-shaping when invoked by garrison (sizing → spec, profile, turn cap, gates)

When garrison invokes this skill, the SAME sizing Phases 1–3 produce — a slice count plus a per-slice size estimate on garrison's 100-point scale — shapes the run. These are planning's own control-plane writes under `<runDir>` + the per-session sentinel; **never target source, the codebase stays read-only.** Every timestamp comes ONLY from `date -u +%Y-%m-%dT%H:%M:%SZ`. (Standalone — no runDir/sentinel — none of this applies; the plan file is the only artifact.)

- **RUN_SPEC.md for significant runs (Part 10.1).** When sizing puts the work **above ~3 slices**, write `<runDir>/RUN_SPEC.md` BEFORE slicing: **what/why** (one paragraph), **acceptance criteria**, **non-goals**, and an **ASSUMPTIONS LEDGER** — every decision planning made on the operator's behalf, each with the **chosen answer AND the alternative**. The FLOW_PLAN slice table then DERIVES from the spec. At or below the threshold, FLOW_PLAN acceptance alone suffices — no ceremony for small work. The assumptions ledger is what makes default fully-autonomous mode reviewable after the fact.
- **`--ask-questions` (Part 10.2, default OFF).** Without the flag: current behavior — decide, record in the assumptions ledger, proceed; **never pause.** With the flag: exactly ONE pause, **AFTER `RUN_SPEC.md` is written** — present the open decisions + assumptions as a numbered queue, wait for the operator's answers, fold them into the spec, mark the spec **locked**, then run fully autonomously to the end. **Sentinel-arming mechanic (garrison's Phase 0, not this skill's):** with `--ask-questions`, arming the goal-loop sentinel is DEFERRED until the answers arrive (so the goal loop does not fight the pause) — signal garrison to arm the sentinel once the spec is locked. This pause is exempt from the never-ask rule **by explicit operator request** and happens **before any code exists.** The flag is recorded in `gatesConfig` so a resume knows the spec was operator-locked.
- **Profile assignment (Part 11.2).** The same sizing assigns the run **profile** — `patch` (≤ ~1 sizing point) / `feature` (1–3 slices) / `build` (≥ 4 slices) — unless the operator forced one; record it in `gatesConfig` and in the RUN_LOG **`RUN-START`** entry, replacing the `pending-sizing` placeholder.
- **Plan-derived turn cap (Part 5.6).** After sizing, UPDATE the sentinel `turnCap` to **`max(300, 80 × slices)`** (a large upward buffer — the cap is a runaway brake, never a schedule) and log the resize as a **`DECISION`** entry in RUN_LOG.
- **Max slice size (Part 5.8).** SPLIT any slice whose size estimate exceeds **~8** (of the 100-point sizing) into sub-slices with their own gates — an oversized slice spans sessions and its interruptions land mid-work instead of on gate boundaries. Intermediate free-form checkpoints remain allowed but are the fallback, not the plan.
- **deliberate-red + mutation defaults (Parts 5.5 / 9.2).** For runs **≥ 3 slices**, set `deliberateRed` + `mutation` **ON** in `gatesConfig` (an operator `--no-deliberate-red` / `--no-mutation` overrides to OFF); below 3 slices they default **OFF**.

## Discipline summary (do / never)
- DO: read `references/plan-mode-prompts.md`; spawn real `Explore`/`Plan` subagents in parallel; write ONE durable plan file; decide instead of asking; keep the plan small. When garrison invokes it: write `RUN_SPEC.md` for work above ~3 slices, split slices sized > ~8, and set the sizing-derived profile / `turnCap` / gate defaults.
- NEVER: call `EnterPlanMode` / `ExitPlanMode`; spawn `claude -p` or an Anthropic-endpoint Agent SDK call; edit any target source (write only the plan file, plus this run's spec + control-plane records when garrison invokes it); ship every alternative in the plan; block waiting for the user in an autonomous run (except the single operator-requested `--ask-questions` pause after `RUN_SPEC.md`).

## Files
- `references/plan-mode-prompts.md` — the verbatim plan-mode prompt corpus (blocks A2–A8): the read-only system-reminder, the 5-phase reminder, the Explore subagent system prompt, the Plan subagent system prompt, the EnterPlanMode trigger heuristic, the ExitPlanMode semantics, and Anthropic's recommended Explore→Plan→Implement→Commit workflow. Read it before Phase 1; the wording is community-reverse-engineered (Piebald-AI / how-claude-code-works / Ronacher) and approximate in later phases — the structure and read-only discipline are authoritative.
