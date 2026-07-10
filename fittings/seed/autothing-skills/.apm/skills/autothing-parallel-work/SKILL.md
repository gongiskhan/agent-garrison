---
name: autothing-parallel-work
description: Decide HOW to split multi-step work across agents and run it safely — agent teams vs dynamic workflows vs sequential, the disjoint-files rule, and which shared runtime must serialize. Use BEFORE fanning a batch of work out to subagents/teammates/workflows (new modules, multi-slice builds, verification/research/design-audit fan-out, migrations), or when deciding whether two units of work can run concurrently at all. Encodes the standing preference — agent teams whenever they fit, workflows where teams don't, sequential only for genuinely shared work. autothing uses this for its build loop; usable directly for any parallelizable task. When the coord stack (beads / agent-mail / coord-mcp) is present, use its planning gate + cross-session file leases for multi-session safety, falling back to the disjoint-files discipline when absent. Do NOT use for the actual editing/testing of a single unit (that is an area/testing skill) or for recording evidence (that is walkthrough).
---

# autothing-parallel-work

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


Parallelize aggressively where it is SAFE; serialize only what genuinely must be. The lesson driving this skill: parallelism is blocked by **shared files** and **shared stateful runtime**, NOT by the agent mechanism. No mechanism makes two agents editing the same file safe — you EARN parallelism by decomposing work into disjoint file ownership.

This is a standalone capability. `autothing` calls it to parallelize its build loop, but use it directly any time you are about to fan work out across subagents, teammates, or workflows.

## The one rule
Parallelize a set of work units only when BOTH hold:
1. **Disjoint files** — each unit owns a different set of files. Two agents editing the same file overwrite each other. This is true for agent teams (official docs: "Break the work so each teammate owns a different set of files") AND for workflows. Across SESSIONS, enforce this with agent-mail file leases + `declare_intent` (see *Cross-session coordination* below) when the coord stack is present.
2. **No shared stateful runtime during the parallel phase** — one dev-serve port, one bundle/build output, and one recorder each serve ONE thing at a time.

A monolith file housing several work units (e.g. one `screens.jsx` with prospects + clients) is a PLANNING problem, not a build-time surprise: split it so the units own disjoint files, THEN parallelize.

## Decompose up front — this is how you get MORE parallelism
- Map each work unit to the files it will edit. If two units touch the same file, either (a) split that file so each owns its piece, or (b) put them in one sequential group.
- Record the chosen group per unit with a ONE-LINE reason ("group A: disjoint screen files"; "S1+S3 share screens-internal.jsx → serial until split"). The parallel-vs-serial choice must be EXPLICIT and logged — never a silent default. (In an autothing build this goes in `FLOW_PLAN.md`'s parallel-group column.)
- Bias toward arranging the work so more of it is parallelizable. If a prototype monolith is the only blocker, plan the split as an early unit of work.

## Pick the mechanism

| Situation | Use | Why |
|---|---|---|
| Parallel IMPLEMENTATION of disjoint-file units (teams enabled) | **Agent team** (preferred) | Teammates coordinate via a shared task list + direct messaging; each owns its files. The "new modules/features, each owns a piece" sweet spot. |
| Parallel verification / research / design-audit fan-out; any unattended/resumable parallel step; implementation when teams are off | **Workflow** | Deterministic, journaled/**resumable** (survives compaction), fire-and-forget. Use `isolation: 'worktree'` for file isolation (needs git). |
| Shared file, single dev-serve/bundle/recorder, or heavy cross-deps | **Sequential** | No mechanism makes same-file edits or one runtime safe. |

Standing preference: **agent teams whenever they fit, workflows where teams don't, sequential only for genuinely shared work.**

## Agent teams — how the lead uses them
Preconditions are OPERATOR-set (a skill cannot enable them): `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (experimental) and Claude Code ≥ 2.1.32. If unset, fall back to workflows.
- The orchestrator is the LEAD. Create a team for a BATCH of disjoint-file units: one teammate per unit. Teammates load CLAUDE.md + skills themselves but NOT the lead's history — so PASTE into each spawn prompt: the relevant area skill (or path + read directive), the acceptance, and the exact file-ownership boundary.
- The lead GATES each teammate's result (committed test green + build/lint clean + design audit + verified walkthrough, as applicable) before marking that task complete. A `TaskCompleted` hook can enforce the gate (exit 2 to reject and send feedback).
- **Require the report BEFORE the teammate's last action, and poll instead of waiting.** Teammates repeatedly finish their work and then go idle WITHOUT sending a final report, leaving the lead blocked. In every spawn prompt, instruct the teammate to send its result message to the lead before its final tool call (report first, then stop). The lead never waits passively: poll teammate/task state on a cadence, and if a teammate sits idle with its task unreported, ping once, then read the result from its working tree and gate that directly.
- **Keep bursts SHORT-LIVED**: create team → run the disjoint batch → gate each → shut down teammates → clean up the team → continue. This sidesteps the documented limit that in-process teammates do NOT survive `/resume`/`/rewind`. Never hold long-lived teammates across a compaction/resume boundary.
- Respect the limits: one team at a time; teammates cannot spawn their own teams; team creation may prompt for approval (confirm it passes under auto mode — if it blocks unattended, use a workflow instead); token cost scales per teammate (fine under ultracode).

## Model routing for spawned workers
Spawned workers — dynamic-workflow `agent()` calls and agent-team teammates — do NOT read skill frontmatter, so every spawn must pass an **explicit** model:
- **Default `sonnet`** for implementation and exploration workers.
- **`opus`** for slices the FLOW_PLAN flags as complex or high-risk.
- **Never `fable`** in the fan-out — `fable` is reserved for the lead session and the plan/review/design-audit skills.

## Worker persistence — partial work must be inspectable
A spawned worker — a dynamic-workflow `agent()` call or an agent-team teammate — that is killed by session death (compaction, a `/resume`/`/rewind` boundary, a crashed process) must leave **inspectable partial work**, never a silent void. This is what makes the "poll, then read the result from its working tree and gate that directly" fallback above actually work — so it is a RULE on how workers are prompted/structured, not a hope: every spawn prompt instructs the worker to write progress **incrementally** to its worktree/output files as it goes — commit or flush each coherent step rather than buffering the whole result to emit only at the very end. A worker that dies mid-task then leaves a partial-but-readable worktree the lead can inspect, rather than an all-or-nothing result that vanishes with the process. Before assuming a spawned task landed, the lead ALWAYS checks that worktree/output — and incremental persistence is what guarantees there is something there to check.

## Always serialize (regardless of mechanism)
- The single dev-serve / app server (one port).
- The single bundle/build output. Two builds — or a build over a live dev server — sharing one output dir (e.g. `.next/`) poison each other's incremental cache. Give any concurrently-running dev server or build its **own isolated dist dir** (or a `git worktree` copy), or serialize them.
- The single recorder (one recording at a time; unique ports + run dirs).

Pattern: teammates/workers implement N disjoint-file units in parallel, then the lead runs each unit's **build → verify → record** tail one at a time. Parallelize the EDITING; serialize the VERIFY/RECORD.

## Cross-session coordination — use the coord stack when present (advisory)
The rules above govern ONE session fanning out. When **multiple Claude sessions** (or the orchestrator + worker sessions) may touch the same repo at once, the disjoint-files rule needs **cross-session** enforcement. If the Garrison **coord stack** is available, USE it; otherwise fall back to the discipline above — **never hard-block on it.** Detect availability cheaply: the coord-mcp + agent-mail MCP tools are registered/connected and `bd` is on PATH. On a machine without Garrison, or a session where the MCP servers aren't connected, proceed EXACTLY as today.

Three layers, each independently optional:
- **Planning gate — coord-mcp.** Before architectural planning, `begin_planning(repo, summary)`: GRANTED returns a read-bundle (last released plan + recent plans + in-flight intents) to plan against; **WAIT** means another session holds the repo's plan lock — honor the bounded wait, or (autonomous) park the task and surface it, never hang. `end_planning` when the plan is written. `autothing-plan` owns this for the build's plan step.
- **File leases + intent — agent-mail + coord-mcp.** When fanning out across sessions, each unit **claims its files as an advisory lease** (path + TTL + heartbeat + reason) before editing, and `declare_intent(area, files, reason)` records it so other sessions' digests surface conflicts. This is the disjoint-files rule made enforceable BETWEEN sessions. Check `coord_digest` first; if a lease/intent collides, treat those files as shared → serialize or pick a different unit. Release leases/intents when the unit is done.
- **Work graph — beads (`bd`).** Track parallel work units as beads issues when present, so progress/blockers are visible across sessions and survive restarts (`bd` is primed each session). Optional — for an autothing build the durable FLOW_PLAN + gate-status files remain the source of truth.

Precedence: the intra-session disjoint-files + serialize-runtime rules ALWAYS hold. The coord stack ADDS cross-session safety on top; it does not replace them. When the stack is absent, the intra-session rules alone are the contract.

## Honest fit note
For a FULLY UNATTENDED multi-hour loop, **workflows are the safer default** (no approval gate, resumable across compaction). **Agent teams** shine for bounded parallel bursts and attended work. Prefer teams where they fit; do not wrap a whole long build in one long-lived team.
