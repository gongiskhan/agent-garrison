# Kanban Loop. Design state and decision record

Purpose: a single capture of everything decided and still open about Kanban Loop, so it can seed a new conversation where related features get discussed against it. Read the decision-status tags carefully. LOCKED means confirmed. PROPOSED means a recommendation awaiting a call. OPEN means genuinely undecided.

---

## 1. What it is

A workflow state machine wearing a Kanban board. Cards are work items. Lists are pipeline states. A list's router-prompt is the transition function that moves a card to the next list.

It is the master list for both personal life and development work. The unification works because most lists are plain manual columns and only a few run an agent. The board does not care which is which.

It is a Garrison Fitting, `automation-runner` kind. It composes the orchestrator, skills, the heartbeat, and channels. It does not become a runtime framework. Compose, do not own.

A list that runs an agent has a named skill, an execute-prompt, and a router-prompt. The agent runs, then the router moves the card. Other lists are manual columns.

Note: Ekoa is a separate project and has nothing to do with this.

---

## 2. Principles guiding the design

- One pattern, not parallel systems. A new concept fits the existing pattern rather than adding one.
- Kanban Loop is a sequencer, not a router. The orchestrator decides effort and model. The board sequences phases and delegates that decision.
- System legibility. You read your system through the composition view, so list configuration stays explicit and visible.
- PTY everywhere. No `claude -p`, no Agent SDK against the Anthropic endpoint.
- Act on a guess only when stakes are low. Title inference can be eager. Anything that drives execution against the wrong target must be gated.

---

## 3. Locked decisions

- Name: Kanban Loop.
- Storage: file per card, JSON, ULID ids, markdown logs, atomic writes. (Detail in section 5.)
- List membership is derived by scanning cards. It is never stored on disk.
- Project inference auto-applies only at 70 percent confidence or above. Below that the card parks in `needs-attention`. Title inference is eager.
- The router prompt receives the explicit set of valid next-list names for the card. Output must exact-match one of them. No match parks the card in `needs-attention`. No guessing, no fuzzy matching.
- Per-card iteration cap. Breach parks the card in `needs-attention`.
- Goal-mode: a card can be flagged `goalMode`. In implement-type lists the engine prepends `/goal` at send time. Execute-prompts never contain `/goal` themselves.
- Vibe-infer is a real intended feature but is deferred. (Detail in section 7.)
- The board UI is a separate brief (V1b), written after the engine (V1a) lands.

---

## 4. The survey, and what it resolved

A read-only survey of Garrison's routing layer and the autothing skills was run. Report saved at `~/.garrison/kanban-loop/routing-survey.md`. Key facts:

The routing layer is one Fitting, `fittings/seed/model-router/`, filling the orchestrator Faculty. Core logic in `lib/routing-core.mjs`. Config in `config/routing.seed.json` or composition-scoped `.garrison/routing.json`.

Decision model (BRIEF v4): exceptions, then matrix of task-type by tier, then inheritance, resolves to a ROLE. The active Profile's `roleMap` maps role to a concrete target. A target carries `{runtime, provider, model, effort, soul}`. Swapping provider, model, or effort means swapping the Profile, never the policy.

- Effort values are `low`, `medium`, `high`. Tiers are `T0-trivial`, `T1-standard`, `T2-deep`. (My earlier brief said `xhigh` and `ultracode`. Those do not exist. Correction noted.)
- Task types are a fixed vocabulary: `code, review, research, image, video, writing, ops, other`. A task is classified by a warm classifier (Stage A), with a deterministic keyword fast-path.
- Profiles: `balanced`, `economy`, `premium`. Providers: `anthropic-plan`, `ollama-local`, `deepseek`, `zai-glm`.

The router decides effort and model. It does not decide skill. There is no task-type to skill map anywhere, by design. Skills load through Claude Code's built-in Skill-tool description matching.

Entry points, neither of which returns a skill:
1. Runtime: `RoutedGateway.preRoute(message)` (factory `createRoutedGateway`, called per inbound turn in `gateway-pty.mjs`). Classifies, resolves, switches the operative onto the target, runs the turn. Returns route with model and effort.
2. Pure decision: `resolveRoute(config, profile, classification)` in `routing-core.mjs`. Deterministic, no I/O. Needs a classification first.

Resolved questions:
- `FINDING:GOAL` is resolved. `/goal` and its Stop hook are present and working (Claude Code v2.1.139). The hook asks a small fast model whether acceptance criteria are met and loops until met or a turn cap. `/goal` wraps the execute step only.
- Completion conditions already exist. `garrison-planning` produces a machine-readable acceptance-criteria block, per-slice `acceptance` in `FLOW_PLAN.md`, meant to be lifted verbatim into the `/goal` condition. Consumed by the `/goal`-wrapped executor and by the validator. So goal-mode reads acceptance from `FLOW_PLAN.md`, not from a separate `completion-conditions.md`. The file I invented in the brief is dropped.
- The goal loop already has a bound. `/goal` loops until acceptance or a turn cap, and the post-plan classifier picks `max_turns`. Reuse `max_turns` as the goal-mode loop guard. Do not invent a new max-loop bound.

---

## 5. Storage contract (LOCKED)

```
~/.garrison/kanban-loop/
  board.json              # list defs, order, per-list config, project rules
  cards/
    <ulid>/
      card.json           # title, project, list, status, iterations, goalMode, timestamps
      log-1.md            # per-session log + summary
      log-2.md
```

- Atomic write (temp file then rename) and read-immediately-before-write on every mutation. Reuse the existing MCP-write helper.
- ULID ids so two simultaneous drops never race for an id.
- `board.json` holds config only, never membership.
- `card.json` fields: `id`, `title`, `description`, `project` (string or `personal` or `tbd` or null), `list`, `status` (`ok`, `running`, `needs-attention`), `iterations`, `cost` (or null if not observable), `goalMode` (bool), `created`, `updated`.

Note: per the routing reconciliation in section 6, `effort` and `model` are removed from `board.json` lists. This is PROPOSED, pending the section 9 decisions.

---

## 6. Engine behavior

When a card enters an agent list: load the list's skill, send execute-prompt plus router-prompt as one combined prompt to one PTY session, capture the session to `log-N.md`, write a summary, apply guards, parse the router result against the valid next-list set, then move the card or flag `needs-attention`.

Trigger modes per list, exactly one each: `immediate` (run on entry), `heartbeat` (run on next beat), `manual` (run only on an explicit start call, wired to a Start button in V1b).

Immediate-run entries pass through a concurrency cap and queue. Never spawn unbounded PTYs.

A card entering `needs-attention` always fires a notification, so a stuck card is never silent. A list can also carry an on-enter action (for example, send a notification). Rich-media notifications are deferred. V1 sends a link to the card.

---

## 7. Features

### Goal-mode (in V1a)

Flagged `goalMode`. In implement-type lists the engine prepends `/goal` and injects the card's acceptance criteria. Acceptance comes from `FLOW_PLAN.md` (produced by `garrison-planning`), not a separate file. The loop guard is `/goal`'s `max_turns`. Execute-prompts never contain `/goal`. This honors the standing rule that prompts are not framed as goals: the engine adds the prefix, the prompt stays clean.

### Vibe-infer (deferred)

A card can be marked `infer` at creation, or given an Infer button while in the Conversation list. When set, the conversation runs using preferences inferred from previous conversations instead of waiting for comments. It still produces the conversation documents, and it still stops at the manual Move gate. Inference replaces participation in the conversation, not approval to advance.

Blocked on the Conversation list and comments-as-conversation, both deferred.

OPEN before this is built: what corpus "previous conversations" reads from. Recommendation is prior card conversation logs, project-scoped, with the memory vault as fallback. Not arbitrary external chat history.

The `infer` field is added when this lands. File-per-card JSON means no migration.

---

## 8. Skill to default-list mapping (candidates from the survey)

The autothing build skills live in `.claude/skills/` (project-scoped). None carry an `effort:` frontmatter key, because effort is the router's job, not the skill's.

| list | skill candidate | note |
|---|---|---|
| Backlog | manual column | inbox |
| To Do | manual column | committed, not started |
| Discuss | none, needs creating | deferred with the Conversation list |
| Infer | not a skill | see section 9, decision 3 |
| Plan | `garrison-planning` | produces plan plus acceptance criteria |
| Implement | `garrison-architecture` shapes it; the `/goal` executor writes | executor is not a discrete skill |
| Review | `code-review` (built-in); `garrison-design-audit` for UI | |
| Test | `garrison-testing` | committed correctness gate |
| Adversarial Review | `code-review` at high effort | no dedicated skill, see decision below |
| Adversarial Tests | `garrison-testing` adversarial pass | no dedicated skill |
| Walkthrough | `run-garrison` | produces the verified walkthrough evidence |
| Validate | `garrison-governance` | gate and DoD record |
| Done | manual column | terminal |

The autothing verb skills, for reference:
- `garrison-planning`: break the goal into slices, maintain `FLOW_PLAN.md`, produce acceptance criteria.
- `garrison-architecture`: decide module boundaries and IO shape, the implement-shaping skill.
- `garrison-testing`: explore-first, then write and run the committed correctness gate (vitest plus playwright e2e).
- `garrison-design-audit`: drive the running app, judge a UI slice against the shell's visual language.
- `garrison-governance`: enforce Definition of Done, write durable gate markers, record `gate-status.json` and `evidence-index.json`.
- `run-garrison`: run, launch, restart, screenshot the app (Playwright driver).

The autothing sequence is driven by `/goal` (convergence, a hook) plus the orchestrator prompt (step-at-a-time sequencing), not by a single driver skill. So Kanban Loop shares autothing's substrate (the verb skills, `/goal`, the router) but is a different sequencer. Autothing-as-a-Kanban-preset stays a deferred idea, not a goal.

---

## 9. PROPOSED decisions (awaiting a call)

These came out of the survey. They are recommendations, not settled.

1. **Delegate effort and model to the router.** Drop per-list `effort` and `model` from `board.json`. Each card move builds a classification from the card and calls the existing `RoutedGateway.preRoute`, the same path channel turns use. Run on the returned target. This removes the real duplication (effort, model, tier judgement). Strongly recommended.

2. **Keep skill off the router.** The survey suggested adding a skill dimension to the router so one call returns skill plus effort plus model. Recommendation is to not do that. It would invent a skill-decider that competes with Claude Code's built-in matching, and it is a new primitive. Skill stays an explicit, visible choice on the list, because legibility matters. The list's named skill and its execute-prompt must point at the same work. One skill-decider (the list), one effort-and-model decider (the router), no overlap.

3. **Kanban owns gates under kanban.** The router already has continuations (`cont-plan` asks "implement this plan?", `cont-report`) that gate plan to implement. The kanban also gates that boundary through list structure and the manual Move. Two gate-owners on the same transition will fight. Recommendation: when a card runs under kanban, the list boundary is the gate, so suppress the router's continuations for that run. The board is the visible gate model. Do not double-gate.

4. **Drop Infer as a standing column.** The survey maps Infer to the classifier, which is router code, not a skill. Inference happens to a card on entry (title, project, tier), not as a phase a card sits in. Fold Infer into the on-entry inference already in the design. A visible holding state for low-confidence inference is just `needs-attention`, which already exists.

5. **Adversarial is a routing signal, not a new skill.** Do not create adversarial-review or adversarial-test skills. Make "adversarial" a signal that lands on high effort, reusing `code-review` and `garrison-testing`. Harder-pass equals more effort, which is the router's job. This is the delegate design paying off.

If decisions 1 to 5 are accepted, the V1a brief gets revised: strip effort and model from `board.json`, wire `preRoute`, fix completion conditions to `FLOW_PLAN.md`, reuse `max_turns`, drop the Infer column, pin the skill names from section 8.

---

## 10. OPEN questions

- **Phase to classification mapping.** The router keys on task-type plus tier, not on a pipeline phase. So the kanban must translate (list or phase, plus card) into a classification before calling `preRoute`. Options: map each list to a task-type and tier, let the classifier infer from card text, or use `contextKind` (currently captured but unused in resolution). Needs a decision.
- **Cost observability under PTY (`FINDING:COST`).** Resolved for goal-mode (use `max_turns`). Still open for the general per-run cost ceiling. If cost is not observable under PTY, the cost ceiling falls back to the iteration cap only, recorded as a known gap.
- **One entry for all autonomous flows.** Not true today. The Improver fitting bypasses routing entirely (`oneShotTurn` direct, no classify, no resolveRoute). Making `preRoute` the universal seam means routing the Improver through it too. This is a separate cleanup. Do not bundle it into Kanban Loop, or it grows a second job.
- **`board.json` `projects` routing rules.** Empty object in V1a. Per-project and per-type skip rules, and auto-skip inference, are deferred.
- **Vibe-infer corpus** (section 7).

---

## 11. Deferred / out of scope for V1a

- Any UI (that is V1b).
- Comments-as-conversation, and the Discuss/Conversation list that depends on it.
- Batch execution (multiple cards sharing one session or environment).
- Rich-media notifications (embedded video or screenshots).
- List CRUD and in-UI config editing. V1a config is hand-edited `board.json`.
- Per-project and per-type skip rules, and auto-skip inference.
- Autothing-as-a-preset, and coupling to autothing internals.
- Routing the Improver through `preRoute`.

---

## 12. Artifacts produced so far

- `kanban-loop-v1a-brief.md`: the explore-first engine and state brief. Predates the survey reconciliation. Needs revision once section 9 decisions are called (effort/model removal, `preRoute` wiring, `FLOW_PLAN.md` acceptance, `max_turns`, Infer column drop, skill names).
- `kanban-routing-survey-prompt.md`: the read-only survey prompt. Done and executed.
- `~/.garrison/kanban-loop/routing-survey.md`: the survey report. Received and folded into this document.

---

## 13. Where this picks up

Decide section 9 (items 1 to 5) and section 10's phase-to-classification question. That unblocks the V1a brief revision. New features should be discussed against the locked spine (sections 3, 5, 6) and the proposed routing model (section 9), so they fit the one-pattern rule rather than adding a parallel one.
