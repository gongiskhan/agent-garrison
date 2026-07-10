# Garrison Roadmap

**Status:** Live working document. Edited during planning conversations.
This is the source of truth for Garrison's phased roadmap — the
restructure of 2026-05-26 replaced the prior Phase 1–9 layout with a
5-Stage layout that reflects the actual priority order: replacing the
IDE and CLI for daily dev work first, the autonomous loop last,
personal-assistant and multi-machine work explicitly deferred.

**Goal:** Get Garrison to the point where it replaces the user's
existing development environment (IDE, terminal, browser tooling,
Claude Code outside Garrison, claude.ai conversations) for a single
machine, then layer autonomy and tasks on top, then expand outward
to other machines and to personal-assistant use cases.

> **Superseded 2026-07-10 (GARRISON-FLOW-V2 D10):** Garrison no longer
> spins up per-task git branches or worktrees. All dev work happens in the
> project repo root on the **current branch**; concurrent tasks coordinate by
> staying off each other's files (touch-set overlap and ordering), not by
> isolating into branches. Forward-looking "worktree view" / "spawn a
> worktree" language below predates this decision - read it as "the dev-env
> session view" / "start a session". Dated "we shipped worktrees" entries in
> the history and decision-log sections are kept verbatim as history.

-----

## North star

A single Operative running locally that:

1. Hosts the user's full development workflow inside Garrison —
   terminals, Claude Code sessions on the current branch, an embedded browser
   for both human and agent inspection, session monitoring,
   screen-share — all as Fittings, all rendered as views in
   Garrison's shell.
   The user can do a full day of dev work without touching VS Code,
   iTerm, or a separate browser.
1. Runs every dev task through a **disciplined pipeline**: classify
   tier → (plan + classify-again if non-trivial) → execute under
   `/goal` → validate against acceptance criteria → run tests →
   package evidence → report. Each step is a single-responsibility
   runner with its own session and its own model choice. Evidence
   bundles land in the Artifact Store; reports surface in the
   originating surface and the dev-env session view.
1. Lets me drive that pipeline from the phone via an improved web
   channel: I'm walking around with my phone, I ask the Operative
   to kick off a session and start work on something, it does; I get
   back to the desk and the dev-env session view shows me exactly what's
   running. Cross-surface continuity is real, not a hack.
1. Replaces my claude.ai PM/Architect discussions with conversations
   inside Garrison. The Operative captures decisions and plans into
   markdown documents in the Documents Fitting as the conversation
   converges. I reference those documents manually when I start
   work.
1. Becomes genuinely autonomous: Tasks Faculty as substrate, the
   Operative creating tasks from discussions, heartbeat picking them
   up, asking for approval, executing through the same Stage 2
   pipeline, returning evidence. One operator running a software
   project entirely through their Operative.

Stages below are **scoping containers**, not strict gates. Earlier
stages have to be solid before later ones can be built on top of
them, but spillover work between stages is fine and expected.

**Inverted from the prior plan (2026-05-26):** the previous roadmap
had personal-assistant work first (Phases 1–3 in the old numbering)
with developer-workflow work later (Phases 4–5). The actual
priority is the inverse. PA work and Outposts are deferred to
post-Stage-5. They are not abandoned — they are deliberately
sequenced behind the developer workflow because that is what the
user actually does all day and what Garrison needs to be useful
for before anything else.

-----

## Cross-cutting: settled context

These are not stage items, just things to keep in mind across the
work.

- **Reference projects, sibling folders.**
  - **`awc-gateway-slack`** (`~/Projects/awc-gateway-slack/`) — the
    real source of the Slack channel and a clean channel-agnostic
    HTTP gateway. Ported during the old Phase 1; relevant now mainly
    as prior art if the Stage 4 / Stage 5 channel work needs
    extending.
  - **Ekus** (`~/Projects/ekus/`) — has the Trello client (ported
    during the old Phase 1) and a Trello agent skill. The Ekus
    *gateway* (2090-line FastAPI doing twelve things at once) is
    not being lifted into Garrison; patterns can be cherry-picked
    as needed.
  - **`~/.claude/memory-compiler/`** — the user's existing working
    memory compiler. The Memory Faculty wraps it. Setup script
    clones the compiler repo and wires Claude Code hooks at the
    user level. This work landed during the old Phase 1.
  - **EKOA** (`~/Projects/ekoa-dev/`) — the source of the
    Automations port that lands in Stage 2 (the old Phase 7
    content). Two automation engines (`cortex/` Playwright
    in-process and `automato/` raw CDP); the engine decision needs
    to be settled before the port begins.
  - **Sequoias** (sibling project on this machine) — fully
    decomposed into Workbench-style flat Faculties (terminal,
    worktrees, session-view) during the old Phase 5 and Phase 5.5.
    Those Fittings collapsed into the single `dev-env` Fitting on
    2026-06-11; the Sequoias standalone app is fully retired.
  - **Harmonika** (sibling project on this machine) — provided the
    screen-share implementation and the terminal/PTY plumbing.
    Source code lifted wholesale during old Phase 5.
  - **Four Macs on Tailscale** — automation, development, portable,
    office. Currently Garrison is single-machine. The Outposts work
    (deferred to post-Stage-5) wires them together.
- **Runtime is the SDK gateway, not `claude` spawn.** The HTTP
  gateway uses `@anthropic-ai/claude-agent-sdk` in-process and
  resumes the same session by id. Auth is the Max account; no API
  key billing.
- **Orchestrator + Soul concatenation already works.** The runner
  reads both prompt files and writes `assembled-system-prompt.md`,
  passed to the SDK as `append`.
- **Permission mode is `bypassPermissions` for now.** Anything
  stricter hangs because the UI has no permission-prompt surface
  yet.
- **No multi-host compositions in v1.** One composition per host.
- **Workbench-as-shell-area is gone.** The 2026-05-17 dissolution
  decision made `terminal`, `worktrees`, `session-view`,
  `screen-share` flat sibling Faculties at the top level. The shell
  renders Fittings whose Faculty appears in the active composition,
  no special Workbench grouping. (Since 2026-06-11, `terminal`,
  `worktrees`, and `session-view` have collapsed further into the
  single `dev-env` Fitting; `screen-share` stands alone.)
- **"Views" is the canonical term for a Fitting's UI surface.**
  Fittings ship one or more views; the shell hosts them.
- **Faculties terminology:** Faculties (slots), Fittings (concrete
  components in slots), Operative (the agent), Garrison (the
  platform). Stay consistent.

-----

## Cross-cutting: the `setup` hook (Fitting lifecycle stage)

**Decided 2026-05-05.** Fittings have a `setup` lifecycle stage that
runs *before* `verify` on every `up`. Standard mechanism for
prerequisites APM can't satisfy: clone a repo, run `uv sync`, write
to host-level config, install a browser binary, set up a tunnel.

Shape in `x-garrison`:

```yaml
x-garrison:
  faculty: memory
  setup:
    command: ./scripts/setup.sh
    idempotent: true
    timeout_ms: 60000
  verify:
    command: test -f ~/.claude/memory-compiler/scripts/compile.py && echo ok
    expect: ok
```

- `command` — relative to the Fitting's installed root.
- `idempotent: true` — author's contract that re-running is safe.
  Runner runs setup on every `up`. If `false`, runner runs setup
  only when `verify` last failed.
- `timeout_ms` — bounded; setup is not a long-running daemon.

Runner behavior: on `up(composition)`, after `apm install` and before
`verify`, runs each Fitting's setup command; on non-zero exit, logs
and aborts `up`. Setup must be idempotent in practice. Setup may
print user-attention messages to stdout but cannot block on stdin.

This is shipped and load-bearing. The Memory Fitting and the Browser
Fitting both depend on it.

-----

## Cross-cutting: `/goal` integration discipline

**Decided 2026-05-26.** Claude Code v2.1.139 shipped the `/goal`
feature — a session-scoped Stop hook that asks a small/fast model
(default Haiku) after every turn whether a stated condition holds,
keeping the session running until it does (or until a turn ceiling
is hit). Stable, documented, headless-compatible.

### Where `/goal` is used in Garrison

**Exactly one place: the execute step of the Stage 2 pipeline.**

When the planner has produced a plan plus an explicit acceptance
criteria block, the orchestrator spawns the executor session as
`claude -p "/goal <acceptance criteria + 'or stop after N turns'>"`
in the project repo on the current branch at the tier-2-chosen model. The session keeps
running until the evaluator agrees the criteria hold or the turn
ceiling is reached.

### Where `/goal` is NOT used

- **Anywhere the orchestrator is doing intent routing or capability
  selection.** `/goal` is a loop convergence check; it has no notion
  of "talk to this Fitting" or "switch hats."
- **The validate-against-plan step.** Validation wants a structured
  pass/fail per criterion, not a loop. A skill call with a schema
  return is the right shape. Letting the executor's `/goal` judge
  its own work defeats the validation step's purpose.
- **Test runs themselves.** Deterministic. A bash call runs them and
  a skill interprets the output if interpretation is needed.
- **Anything the evaluator can't see from the conversation.** If the
  success condition is "the user is happy with this," `/goal` can't
  help — the evaluator has no eyes on the user.
- **Tier 1 (trivial) tasks.** The per-turn Haiku evaluator call adds
  cost that's not worth it for short, obvious work.

### Acceptance criteria authorship

The **planner writes the acceptance criteria** as an explicit,
structured "definition of done" block within the plan artifact. The
orchestrator lifts that block verbatim into the `/goal` condition
string, appending the "or stop after N turns" ceiling clause. The
planner's prompt has this discipline baked in.

### When `/goal` gives up

Control returns to the orchestrator with the evaluator's last reason.
**The orchestrator owns the recovery decision** because it owns the
tier classification and the original intent. Options it picks
between:

- Re-plan (loop back through the Plan node, possibly at a higher
  tier).
- Hand back to the human with the evaluator's reason as context.
- Accept partial (mark the run as partially-complete in the evidence
  bundle).
- Retry with expanded scope or different model.

The `/goal` mechanism itself never decides any of these — it just
hands back with a reason.

### Risk to keep in mind

`/goal`'s evaluator is the configured small/fast model (Haiku by
default) and judges only what the conversation surfaces. If the
executor session doesn't surface enough of what it did, the
evaluator can falsely conclude the goal is met. Garrison should
have the planner write acceptance criteria that *force the executor
to surface evidence* (e.g. "all tests in `pnpm test` pass and the
final assistant message includes the test output verbatim"), not
just stateful criteria ("the bug is fixed").

-----

## Cross-cutting: Workflow tool (parked)

**Decided 2026-05-26.** Claude Code v2.1.147 shipped a Workflow tool
gated behind `CLAUDE_CODE_WORKFLOWS=1`. JavaScript files that run
deterministic multi-agent fan-out with resume. Real, runnable,
deliberately undocumented by Anthropic.

**Garrison is not adopting it for v1.** Reasoning: the existing
Stage 2 pipeline as designed doesn't have a step that genuinely
needs parallel multi-agent fan-out. The Ekoa Automations port is
deterministic Playwright already — Workflow adds nothing there.
Validate-against-plan would benefit from parallel-criterion
evaluation but is fine as a sequential skill call in v1.
Adopting an undocumented env-gated feature for a marginal benefit
isn't worth the architectural and stability risk.

**Revisit signal:** if the feature gets official documentation, or
if it shows up in the YouTube content the user follows as a serious
production pattern, re-evaluate then.

**Research artifact** lives in conversation history (2026-05-26
deep-research report) and need not be re-done.

-----

## Cross-cutting: Garrison-as-AI-composer (future direction)

**Status:** captured, not yet phased. Build advisory/validation
version when there's a concrete need for it.

Garrison today is purely deterministic: read manifests, resolve the
capability graph, install Fittings, concatenate prompts, run the
Operative. An AI-composer adds an LLM-assisted step at compose or
apply time that reasons about the composition.

Two flavors:

- **Option (a) — advisory/validation.** Composition stays
  deterministic. An assembler agent runs at apply time, reads the
  selected Fittings + their `for_consumers` + soul + orchestrator
  + capability graph, and produces warnings, recommendations, and
  friction reports. The human accepts or rejects.
- **Option (b) — synthesis.** The runner asks an LLM to *write* the
  assembled system prompt. Risks: non-reproducibility, cost,
  debuggability. **Not recommended for the foreseeable future.**

Build (a) when one or more of: compositions get big enough to be
hard to reason about unaided; `for_consumers` blocks start
contradicting each other in ways static analysis can't detect; a
meaningful number of Fittings exist and novice users need help
picking compatible sets.

Tracked as a future phase, exact number TBD.

-----

## Cross-cutting: UI surfaces

UI extension contract evolves in steps. Each contract is additive
under the next.

- **Contract v1** (per the original `AGENTS.md` §9): single React
  component per Faculty tab. Static, no sandbox, trusted-author
  model. Used by early Phase 1 Fittings (Slack, Memory).
- **Contract v2** (Phase 3 / Stage 1 work, shipped): multi-view
  Fittings, placement (`faculty-tab` vs `sidebar-surface`),
  in-Fitting routing, cross-tab linking via
  `garrison://<fitting>/<view>` URLs. Workbench/Armory Fittings
  use v2. Documents and Artifact Store browser use v2.
- **Contract v3** (Stage 2 + Stage 5 work): adds the event bus for
  Fitting → Operative talkback. Stateful UI feedback loops.

Phase 1 Fittings keep their v1-style single-pane UIs and migrate
opportunistically when one needs richer UI than v1 can carry.

-----

## Stage 1 — Replace IDE + CLI for working on agent-garrison itself

**Status: largely shipped; refining for daily use.**

**Outcome:** The user can do a full day of development work on
`agent-garrison` itself entirely inside Garrison's shell. Current-branch
Claude Code sessions, terminals, browser inspection, session
monitoring, screen-share — all rendered as views inline. No external
IDE, terminal, or browser tooling needed for the dev workflow.

### What's shipped

Per the old Phase 5 and Phase 5.5 work, fully decomposed after the
2026-05-17 Workbench dissolution into flat sibling Faculties, then
re-consolidated where noted (2026-06-11 Dev Env consolidation):

- **`dev-env` Fitting (consolidated 2026-06-11, port 7086)** — the
  former `terminal-armory-default` (xterm.js + PTY backend,
  multi-session, busy/idle indicators, launch presets),
  `worktree-management-sequoias` (git worktree CRUD, deterministic
  port allocation, env-file rewriting, `package.json` patching),
  and `session-view-sequoias` (`~/.garrison/sessions/state.json`
  badges driven by Claude Code hook events) Fittings collapsed
  into one tabbed surface: every Claude Code session is a tab
  holding a Claude PTY + shell PTY (left) and the live browser
  pane (right), with a quick-prompt bar and PR / commit-and-push
  actions on the current branch in the menu. The `workspaces` Fitting
  was deleted outright with no successor.
- **`screen-share` Faculty + `screen-share-default` Fitting** —
  macOS screen capture surface watchable from any Garrison client.
- **Views terminology + contract v2 wiring.** Fittings ship views
  with `faculty-tab` and `sidebar-surface` placements; the shell
  renders them. Cross-tab `garrison://` links resolve.
- **Documents Fitting + Artifact Store** (old Phase 3, shipped
  2026-05-08). Markdown documents authored by the Operative,
  rendered in a sidebar surface; Artifact Store as the underlying
  storage with namespaced filesystem layout. Used in Stage 4
  primarily, but already wired.

### What remains for Stage 1

1. **Browser Fitting completion + polish.** Per the 2026-05-25
   research, architecture is settled (Playwright-managed headless
   Chromium, CDP for Operatives, viewport WebSocket for the UI,
   input WebSocket for touch/keyboard). The user is currently
   implementing and refining. Operative-side ergonomics: the
   Operative can proactively grab screenshots, console output,
   network logs, and drive the browser without disrupting the user.
1. **Dev-env session view UX polish.** Buttons to open Claude Code with
   the right flags (continue / new prompt / specific tier-aware
   model), navigation between views inline, "this is the view that
   matters right now" affordances. The goal is to make the dev-env
   session view the natural starting point of every dev task.
1. **Sequoias retirement (T8 from Phase 5) — landed 2026-06-11.**
   The Dev Env consolidation closed this: terminal, worktree
   management, and session view collapsed into the `dev-env`
   Fitting, and the standalone Sequoias app is no longer used.
   (Superseded 2026-07-10: worktree management was removed entirely;
   `dev-env` runs sessions on the current branch.)
1. **Daily-use smoke pass.** A deliberate week of working on
   agent-garrison entirely inside Garrison. Bugs surface, polish
   gets applied, the experience is real-world hardened.

### Stage 1 done when

- I open Garrison in the morning. I start or pick a session from
  the dev-env view. Each Claude Code session is a tab with its
  Claude PTY and a shell PTY, the browser pane alongside to test
  the running dev server. Session status badges tell me what's
  working and what's idle. I get through the whole day without
  opening VS Code, iTerm, or Chrome separately.
- The Browser Fitting handles both interactive browsing from the
  iPad over Tailscale AND CDP access from Operative-driven
  inspection, concurrently and reliably.

### Open questions for Stage 1

- Browser Fitting iPad keyboard handling — hidden text input that
  focuses when CDP reports a focused text field. The May 25
  research flagged this as a pattern that needs implementation
  verification.
- Browser Fitting context isolation — separate profiles per session
  vs one shared instance with separate contexts. Lean: one Chromium,
  many contexts, profiles persisted per named context under
  `~/.garrison/profiles/`.

-----

## Stage 2 — Disciplined dev pipeline (active focus)

**Status: design locked 2026-05-26; implementation pending.**

**Outcome:** Every dev task the user initiates from a dev-env session view
runs through a fixed pipeline. The pipeline is composed of
single-responsibility runners: classify → (plan + classify-again
if non-trivial) → execute under `/goal` → validate → test →
package evidence → report. Each step gets its own session with its
own model and effort, chosen for that step's actual cost/quality
tradeoff. Evidence bundles land in the Artifact Store; reports
surface in both the originating surface and the dev-env session view.

This is the disciplined dev workflow. The user drives it manually
from dev-env session views in Stage 2 (no autonomous spawning yet —
that's Stage 3). The full pipeline must be solid before Stages 3, 4,
or 5 can build on top of it.

### The pipeline

```
[user intent from a dev-env session view]
   │
   ▼
[Classify-1]
   │ trivial
   ▼
   [Execute] ─▶ [Validate] ─▶ [Test] ─▶ [Evidence] ─▶ [Report]

   │ non-trivial
   ▼
[Plan] ─▶ [Classify-2] ─▶ [Execute] ─▶ [Validate] ─▶ [Test] ─▶ [Evidence] ─▶ [Report]
```

### Single-responsibility runners

Each step is one process, one session, one Fitting (or capability
provider) doing one thing.

- **Classifier (Faculty: `classifier`; one Fitting, two entry
  points).** Decided 2026-05-26: tier classification is two-stage.
  - *Entry 1 — classify-pre-plan.* "Is this trivial or
    non-trivial?" Gates whether to plan at all. Fast call, cheap
    model. Output: `trivial` (skip to execute) or `non-trivial`
    (proceed to plan).
  - *Entry 2 — classify-post-plan.* Reads the plan + acceptance
    criteria, chooses executor model and effort. Output:
    `{model, effort, max_turns}` for the `/goal`-wrapped executor.
  - One Fitting with two entry points (less proliferation; the
    underlying skill is "judge complexity from inputs" with
    different inputs). Easy to split if they diverge later.
- **Planner (Faculty: `planner`; separate session per call).** Spawns
  its own Claude Code session, Opus with extended thinking, on the
  current branch. Reads the intent + repo context, produces:
  - A plan (markdown) — the architectural / file-by-file reasoning.
  - An **acceptance criteria block** — structured, machine-readable,
    intended to be lifted verbatim into the `/goal` condition.
  Planner's prompt has the discipline of writing both baked in.
  Output artifact lands in the Artifact Store under
  `dev-evidence/<session>/<run-id>/plan.md`.
- **Executor (existing Claude Code session on the current branch,
  wrapped in `/goal`).** Spawned per the surface-aware orchestration brief
  (2026-05-13), tier-aware respawn applies. The wrapping is
  `claude -p "/goal <acceptance criteria + 'or stop after N turns'>"`
  in headless mode. When `/goal` reports back (success or give-up),
  control returns to the orchestrator.
- **Validator (Faculty: `validator`; separate session per call).**
  Cheap model (Haiku or Sonnet-low). Reads the diff produced by
  the executor and the acceptance criteria; returns a structured
  `{criterion, pass: bool, evidence: string}[]`. Can invoke
  pre-written automations from the Automations Faculty when
  validation needs browser/UI work — these are reproducible scripts,
  so they don't need Opus to drive. Validator's job is mostly
  orchestration over deterministic things plus schema-shaped
  judgment.
- **Test runner (Faculty: `testing`; deterministic).** Runs whatever
  the project declares: `pnpm test`, project-specific commands.
  Bash, no LLM. Output captured as a single artifact.
- **Evidence packager (Faculty: `evidence` — see open question;
  deterministic script).** Gathers prompt, classified tier(s), plan,
  acceptance criteria, full diff, test output, validator output,
  any screenshots/recordings produced during the run, optional full
  session transcript (gitignored by default). Bundles into the
  Artifact Store under `dev-evidence/<session>/<timestamp>/`.
- **Reporter (Orchestrator Fitting's job).** Surfaces the result
  with a link to the evidence bundle. Routes by origin (per the
  May 13 surface-aware brief): session-origin → dev-env session view;
  channel-origin → channel; **and always to the session view as
  well**, deduped by run ID. (Decided 2026-05-26: report lands in
  both.)

### Orchestration model

**Step-at-a-time, orchestrator-driven.** Decided 2026-05-26. The
orchestrator (prompt-based Fitting) drives every transition between
steps. After each step completes, the orchestrator reads the result,
decides what next, invokes the next runner. This is more chatty than
a single long-running pipeline runner, but it preserves the
"orchestrator is the spine" principle and lets the orchestrator
interrupt or redirect at any boundary.

### `/goal` integration

See the cross-cutting `/goal` discipline section above for the full
rules. Summary in context:

- `/goal` wraps the **execute step only**.
- Acceptance criteria come verbatim from the planner.
- When `/goal` gives up, the orchestrator decides recovery (re-plan,
  ask human, accept partial, retry with expanded scope).
- `/goal` is not used inside the validator, the tester, or any other
  step.

### Dependencies — existing briefs feeding into Stage 2

- **May 12 — `mcp-gateway` Fitting brief.** Exposes installed
  Faculties as MCP tools to workbench-launched Claude Code sessions.
  Initial Faculty surface designed for tier-classifier and testing.
  **Audit needed:** does the existing brief assume a single
  classifier entry point, or can it accommodate the two entry
  points decided 2026-05-26?
- **May 13 — Surface-aware orchestration brief.** One orchestrator
  per user, origin-tagged turns, tier-aware respawn via
  `--resume --model`. Workbench-mode vs channel-mode spawn.
  **Audit needed:** does the existing brief's spawn shape work
  cleanly with `/goal` wrapping? A 10-minute spike to verify.
- **Browser Fitting (Stage 1 in progress).** Stage 2's validator can
  invoke browser-driving automations through the Browser Fitting's
  CDP endpoint.
- **Documents Fitting + Artifact Store (shipped, old Phase 3).**
  Plan, acceptance criteria, and evidence bundles all land in the
  Artifact Store.

### Stage 2 done when

- I type "implement X" in a dev-env session view.
  Classify-1 fires. Trivial → straight to execute. Non-trivial →
  planner runs in a separate Opus session, writes plan +
  acceptance criteria, classify-2 reads it, picks executor model.
  Executor runs under `/goal`. Validator runs in a separate
  cheap-model session, returns pass/fail per criterion. Test runner
  runs deterministic tests. Evidence packager bundles everything
  into the Artifact Store. Report surfaces in the session view (and
  chat if chat-initiated).
- When `/goal` gives up, the orchestrator gets the evaluator's last
  reason and decides recovery.
- Existing Ekoa automations can be invoked from the validator
  session as a single tool call.
- No orchestrator-driven spawning yet — every run is user-initiated
  from a view.

### Out of scope for Stage 2

- Orchestrator spawning sessions or pipelines autonomously
  (Stage 3).
- Mobile/channel-initiated pipelines (Stage 3).
- Document writing during PM/Architect discussions (Stage 4).
- Task-driven autonomous loop (Stage 5).
- Workflow tool integration (parked indefinitely).

### Open questions for Stage 2

- **Evidence Faculty home.** The evidence packager is deterministic
  glue. Options: a dedicated `evidence` Faculty with a single
  script Fitting; a method on the Artifact Store; a step inside the
  validator's output handling. Lean: **dedicated `evidence`
  Faculty**, simple script Fitting. Keeps the responsibilities
  clean.
- **Validator invoking automations.** The validator Fitting
  `consumes: automation-runner`? Probably yes. Confirm at impl.
- **`/goal` under headless spawn — spike needed.** Does
  `claude -p "/goal ..."` work cleanly under the exact spawn shape
  the May 13 tier-aware respawn brief uses? What's the per-turn
  evaluator token cost in practice?
- **Planner's "acceptance criteria" block format.** YAML, JSON,
  markdown checkboxes? Needs to be both human-readable in the plan
  artifact and machine-extractable for the `/goal` condition. Lean:
  markdown checkboxes with a fenced YAML block as the structured
  source.
- **Recovery loop bounds.** When `/goal` gives up and the
  orchestrator decides to re-plan, how many re-plan loops are
  allowed before forcing human handoff? Lean: hard cap at 2
  re-plans, then mandatory human.
- **Audit of existing tier-classifier work and the May 12
  `mcp-gateway` brief.** Both predate the two-stage-classifier
  decision. May need adjustment.
- **Classifier-1 model.** Lean: Haiku, fast and cheap. Confirm at
  impl.

-----

## Stage 3 — Mobile / orchestrator-driven dev workflow

**Status:** scoped; depends on Stage 2 being solid.

**Outcome:** The orchestrator can spawn sessions and kick off
pipelines on the user's behalf. The user drives this from mobile
via an improved web channel. When the user gets to the desk, the
dev-env session views show what's running and the user continues inline.
Cross-surface continuity (mobile → desk) is the headline experience.

### Scope

1. **Web channel improvement.** The current web channel is crude
   per the user's own description (2026-05-26). Stage 3 brings it
   to a level that supports real conversation, real handoff to the
   pipeline, real status feedback. Visual polish, mobile keyboard
   handling, threading, evidence bundle linking.
1. **Orchestrator gains pipeline-invocation capability.** The
   orchestrator can call out: "start a session on the current branch,
   run the disciplined pipeline against intent Y." All the Stage 2
   plumbing is reused; the orchestrator is just a new *initiator*
   of the same pipeline.
1. **One orchestrator per user, origin-tagged turns** (per the
   May 13 brief). Cross-surface continuity: ask something on the
   phone, follow up on desk, the orchestrator sees both.
1. **Tier-aware respawn fully wired with `/goal`.** When mid-session
   the work re-classifies to a different tier, the executor session
   gets respawned with the new model. `/goal` resumes with the
   same condition.

### Stage 3 done when

- I'm walking around with my phone. I message the operative: "start
  a session for the screen-share Fitting bug fix and start work."
  The orchestrator does it. The pipeline runs. The phone shows me
  status. I get back to the desk and the dev-env session views show me
  exactly what's happening; I can take over inline.
- A mid-session tier escalation works: simple bug fix turns out to
  need a redesign, classifier-2 says Opus, executor respawns with
  Opus, `/goal` resumes against the same condition.

### Open questions for Stage 3

- Web channel UX choices — how much polish is "enough" before
  Stage 3 ships vs continuing to refine in parallel.
- Session-spawning permission model. Does the orchestrator
  unilaterally spawn sessions, or does it ask first? Lean:
  unilateral for tier ≤ 2; asks for tier ≥ 3.
- "Take over inline" UX — how does the dev-env session view know which
  orchestrator-initiated run to surface as the active one?

-----

## Stage 4 — Replace claude.ai discussions in Garrison

**Status:** scoped; substrate (Documents Fitting + Artifact Store)
already shipped. Behavioral discipline missing.

**Outcome:** PM/Architect-style discussions happen in Garrison's
chat with the operative instead of in claude.ai. The operative
captures decisions and plans into markdown documents (Documents
Fitting from old Phase 3) as the conversation converges. The user
references these documents manually to start work in the Stage 2
pipeline.

The substrate (chat, documents, artifact store) is already shipped.
What's missing is the **behavior**: the PM/Architect hat, the
discipline of writing documents during conversation, the chat UX
for long-form discussion.

### Scope

1. **PM/Architect hat in Soul + Orchestrator.** Soul declares the
   hat exists and what it sounds like. Orchestrator detects when
   to engage it (project mentioned, code in message, dev-flavored
   verbs). The detection logic lives in the orchestrator, not the
   soul — already decided 2026-05-05.
1. **Document-during-conversation discipline.** Operative
   proactively writes documents into the Documents Fitting when a
   discussion has converged on something worth capturing. The
   trigger lives in the Documents Fitting's `for_consumers` block
   (locality principle from old Phase 3).
1. **Improved chat UX for long-form discussions.** Phone and desktop
   both support real-back-and-forth conversations, document linking
   inline, easy reference to past discussions.
1. **Document → session-view referencing.** Pin a document while
   working in a session; the operative can read it as context.

### Stage 4 done when

- I open Garrison, chat with the operative about a new feature for
  agent-garrison. The conversation converges. The operative says:
  "I've captured this in a document — see
  `garrison://documents/<id>`." I click through, read it, edit if
  needed. Later, when I'm ready, I pin the document and start work
  on it through a dev-env session view + Stage 2 pipeline. The whole
  flow happens inside Garrison, no claude.ai.

### Stage 4 v2 (deferred to Stage 5 transition)

The operative reads its own captured document and acts on it
directly — kicking off a pipeline against it. That's Stage 5
territory because it requires task-driven autonomy.

### Open questions for Stage 4

- Trigger for "the discussion has converged" — heuristic in the
  `for_consumers` text, or explicit user signal? Lean: both.
  `for_consumers` describes the heuristic; user can also say
  "capture this" explicitly.
- Document evolution — when the user revisits a topic, does the
  operative update the existing doc or write a new one? Lean:
  update existing if the topic matches a recent doc, otherwise new.
- Chat history vs document — what's the boundary? Chat is the
  ephemeral conversation; the document is the durable artifact.
  Operative decides what to lift.

-----

## Stage 5 — Autonomous loop

**Status:** scoped; depends on Stages 2, 3, 4.

**Outcome:** Tasks Faculty as substrate. The operative creates tasks
from discussions (Stage 4). Heartbeat picks tasks up. Operative
asks the user for approval, executes via the same Stage 2 pipeline,
returns evidence (bundled via the Stage 2 evidence packager).

The point of Stage 5 is that **the entire underlying mechanism is
already built by then**. Stage 5 is the autonomy layer on top of an
otherwise complete system. The pipeline doesn't change; only the
*initiator* changes (heartbeat instead of user).

### Scope

1. **Tasks Faculty (old Phase 8).** First-party file-system-backed
   task store with a Kanban UI, replacing Trello as source of truth.
   Trello becomes optional via a Trello-sync Fitting. Markdown
   files with YAML frontmatter; four-column board
   (backlog/todo/in_progress/done) for v1.
1. **Heartbeat-driven task pickup.** Heartbeat reads tasks in
   `todo`, picks one matching autonomy-allowed criteria, runs it
   through the Stage 2 pipeline.
1. **Plan-then-approve gate for higher tiers.** Classifier-2 says
   Opus → orchestrator pauses and asks the user via chat/channel:
   "I want to work on X, here's the plan, can I proceed?" User says
   yes → executor runs.
1. **Evidence return.** When the pipeline completes, the operative
   posts the evidence bundle link as a comment on the task and
   moves the task to `done`. Trello-sync (if installed) propagates.
1. **Task creation from Stage 4 discussions.** PM/Architect hat
   captures discussions into documents AND into tasks when the
   discussion produced actionable work items.

### Stage 5 done when

- I have a chat in the morning, the operative captures the
  discussion into a document and creates three tasks from it. I
  approve. Heartbeat picks the first task up, runs it through the
  pipeline, returns evidence on the task card. The whole loop runs
  while I'm doing something else; the operative messages me when
  there's something to approve or when work is done.

### Open questions for Stage 5

(See deferred Phase 8 content in the parking lot section. Most
already captured; refresh when Stage 5 gets close.)

-----

## Deferred: Personal-assistant work

**Why deferred:** The user's actual daily workload is dominated by
software development on agent-garrison itself and adjacent projects.
The personal-assistant pieces (Slack as primary channel, Trello as
PA, calendar, briefings, heartbeat-driven non-dev suggestions) are
real and wanted, but they're back-burner relative to making the
dev workflow truly usable.

**What's shipped from this area (per old Phase 1):**
- Memory Faculty wraps `~/.claude/memory-compiler/`.
- Slack channel Fitting (ported from `awc-gateway-slack`).
- Trello data-source Fitting (ported from Ekus).
- Heartbeat Fitting (off by default).
- Classifier and Orchestrator Fittings with `cardinality: any`
  composition awareness.

**What's deferred:**
- Heartbeat picking up Trello tasks for PA suggestions (old
  Phase 2).
- Google Calendar integration (old Phase 2).
- Morning briefing flow (old Phase 2 T6/T7).
- Slack as primary channel for non-dev conversations.
- The "two hats" auto-detection extended to PA contexts.

**Preconditions to un-defer:** Stages 1–5 solid. Operative
genuinely useful for dev work end-to-end. Then PA work picks up
where old Phase 2 left off.

-----

## Deferred: Outposts (multi-machine)

**Why deferred:** Old Phase 6 was a substantial design (bridge
process per remote Mac, WebSocket over Tailscale, `outpost-actions`
agent skill, vault sync). It's the right direction long-term. But
single-machine has to be rock-solid first — the user explicitly
said as much on 2026-05-26.

**Preconditions to un-defer:** Stage 5 solid. The user is genuinely
running Garrison as their development environment on the
automation machine, with the Stage 2 pipeline turning out evidence
bundles consistently. Then Outposts adds the multi-machine layer
without distraction.

**What's preserved from old Phase 6:** the architectural sketch
(bridge protocol, `outpost-actions` skill, vault sync as first
service) stays in the prior roadmap version. Reload when the work
becomes active.

-----

## Deferred: Knowledge & Self-Improvement

**Why deferred:** Old Phase 9 was a placeholder for the
multi-machine knowledge consolidation, self-improving skills /
automations / `for_consumers` blocks, Operative identity across
machines, and lessons-learned feedback loop. It depends on
Outposts (transport), Automations (feedback loop), and Tasks
(outcome signals) — all of which are themselves dependent on
earlier stages.

**Preconditions to un-defer:** Stage 5 in flight; outcome signals
from the Tasks pipeline are real and observable; Outposts is
shipped. Then prior-art research (Hermes/GEPA, Voyager, Anthropic
Skills evolution direction) feeds detailed planning.

-----

## Decision log (live)

Append-only. Each decision dated and short.

- **2026-05-26** — Roadmap restructured: 9 phases → 5 stages.
  Priority inverted: developer-environment replacement is Stage 1;
  claude.ai discussion replacement is Stage 4. Personal-assistant
  work and Outposts deferred to post-Stage-5. Knowledge &
  Self-Improvement (old Phase 9) deferred. Workflow tool
  (Claude Code v2.1.147, env-gated) dismissed for v1 — revisit if
  external signals justify a second look. Decision log preserved
  verbatim from prior structure; entries below this point use the
  new Stage numbering.
- **2026-05-26** — `/goal` (Claude Code v2.1.139) adopted as the
  execute-step wrapper for Stage 2's disciplined pipeline. Used
  exactly once, around the executor session. Acceptance criteria
  written verbatim by the planner; orchestrator lifts them into the
  `/goal` condition with a "or stop after N turns" tail clause.
  When `/goal` gives up, control returns to the orchestrator with
  the evaluator's last reason; orchestrator owns the recovery
  decision (re-plan, ask human, accept partial, retry with expanded
  scope). `/goal` is NOT used inside validator, tester, or any
  other step. See cross-cutting "/goal integration discipline."
- **2026-05-26** — Tier classifier is **two-stage**: classify-1
  ("trivial vs non-trivial," gates planning) and classify-2 (reads
  the plan, chooses executor model and effort). One Fitting with
  two entry points. Easy to split into two Fittings later if they
  diverge.
- **2026-05-26** — Stage 2 pipeline: classify-1 → (plan →
  classify-2)? → execute under `/goal` → validate → test → evidence
  → report. Each step is a single-responsibility runner with its
  own session and model. Planner runs in its own Opus + extended-
  thinking session. Validator runs in its own cheap-model session
  (Haiku or Sonnet-low), can invoke pre-written automations from
  the Automations Faculty for reproducible browser/UI checks.
- **2026-05-26** — Orchestration model: step-at-a-time,
  orchestrator-driven. The orchestrator (prompt-based) drives every
  transition between pipeline steps. Preserves the
  "orchestrator-is-the-spine" principle.
- **2026-05-26** — Evidence bundles include the full session
  transcript (gitignored by default, optional to surface). Lands in
  Artifact Store under `dev-evidence/<session>/<timestamp>/`.
  Default contents: original prompt, classified tier(s), plan +
  acceptance criteria, full diff, test command output, validator
  output, screenshots/recordings, summary.
- **2026-05-26** — Report routing: both the originating surface
  (channel or session view) AND the dev-env session view, deduped by run
  ID.
- **2026-05-26** — Audit items flagged: existing tier-classifier
  work and the May 12 `mcp-gateway` Fitting brief both predate the
  two-stage-classifier decision; need verification and possibly
  adjustment. May 13 tier-aware respawn brief needs a spike to
  confirm clean interaction with `/goal` wrapping.

— *Entries below preserved verbatim from prior roadmap.* —

- **2026-05-11** — Phase 9 placeholder: Pillar B framing simplified.
  Previous "evolvable artifacts" name collided with Phase 3's
  Artifact Store. Pillar B renamed to its concrete contents: *self-
  improving skills, automations, and `for_consumers` blocks.*
- **2026-05-11** — Phase 9 placeholder expanded from two to four
  pillars: knowledge layer (A), self-improving skills/automations/
  for_consumers (B), Operative identity across machines (C),
  lessons-learned feedback loop (D). Detailed planning still
  deferred (now to post-Stage-5 per the 2026-05-26 restructure).
- **2026-05-11** — Phase 9 placeholder: Hermes and Voyager prior-art
  researched. Empirical review (Hermes/GEPA-style) is the
  established discipline. Scoping limited to refinement, not
  auto-generation of new skills. Honest acknowledgment that
  Garrison lacks Voyager-style clean ground-truth signals.
  DSPy + GEPA noted as evaluation target.
- **2026-05-11** — Phase 9 added as placeholder: Knowledge &
  Self-Improvement. Deferred to when Phase 8 (Tasks) is in flight.
- **2026-05-11** — Phase 6 added: Outposts (multi-machine bridge).
  Bumped Automations to Phase 7, Tasks to Phase 8. (Per 2026-05-26
  restructure, all deferred to post-Stage-5.)
- **2026-05-11** — Phase 5 implemented: Workbench shell area + 4
  seed Fittings. (Per 2026-05-17 dissolution, Workbench shell
  removed; the 4 Fittings became flat sibling Faculties.)
- **2026-05-17** — Workbench dissolution: `terminal`, `worktrees`,
  `session-view`, `screen-share` became flat sibling Faculties at
  the top level. No Workbench grouping; no meta-Faculty. The shell
  renders Fittings dynamically based on their declared Faculty.
- **2026-05-08** — Phase 4 implementation observations. SDK exposes
  `Query.interrupt()` for cancellation. Sub-agent invocation chose
  Variant A (CLI-shape, looks like every other Fitting). Setup hook
  re-runs on every Operative up.
- **2026-05-08** — Phase 5 reframed: Trenches → Workbench (then
  flat Faculties, per 2026-05-17). Earlier "Trenches as a separate
  Garrison-core area" was a category error against the platform
  thesis.
- **2026-05-08** — Phase 3 implementation adaptations. Static view
  registry instead of dynamic import; `cli-skill` shape valid under
  `knowledge-base` Faculty; textarea instead of tiptap; mini
  markdown renderer instead of full react-markdown.
- **2026-05-08** — Phase 2 implementation observations. Gateway uses
  `/jobs` for system-triggered prompts (not `/chat`).
  `personal-operative.report_channel` config owns system-message
  routing. Validator forces `automations + cli-skill` combo.
- **2026-05-06** — Phase 1 marked complete. Phases renumbered.
- **2026-05-06** — UI contract evolution split into v1 / v2 / v3.
  v1 → v2 (multi-view, placement, routing, cross-tab linking) →
  v3 (event bus for Fitting → Operative talkback).
- **2026-05-06** — `for_consumers` field added. Provider-side usage
  instructions, concatenated into the Orchestrator's "tools
  available" block at assembly time. Locality principle.
- **2026-05-06** — Garrison-as-AI-composer: capture as future
  direction, build advisory/validation flavor only when concrete
  need surfaces. Synthesis flavor rejected for foreseeable future.
- **2026-05-06** — Testing & Automations stay separate Faculties.
  Testing `consumes: { kind: automation-runner, cardinality:
  optional-one }`.
- **2026-05-06** — Artifact Store Faculty added (under what was
  Phase 3, shipped). Layered under Documents. Documents owns
  intent; Artifact Store owns substrate.
- **2026-05-06** — Phase 8 added: Tasks Faculty (Kanban-as-control-
  plane). First-party file-system-backed task store. Trello-sync
  Fitting replaces direct Trello dependency. (Per 2026-05-26
  restructure, this becomes Stage 5.)
- **2026-05-05** — Phased plan adopted (later restructured to
  stages 2026-05-26).
- **2026-05-05** — `setup` hook lifecycle stage adopted. Runs before
  `verify` on every `up`. Schema in `x-garrison` with `command`,
  `idempotent`, `timeout_ms`.
- **2026-05-05** — Memory Fitting wraps `~/.claude/memory-compiler/`,
  installed via setup hook. Compiler is its own GitHub repo. Schema
  rename: `compiled_memory_path` → `compiled_memory_dir`.
- **2026-05-05** — Capability resolver `cardinality: "any"` already
  wired end-to-end. Orchestrator declares one `consumes` per
  capability kind with `cardinality: any`. Runner injects resolved
  provider list into system prompt at assembly time.
- **2026-05-05** — Slack source: port from `awc-gateway-slack`, not
  Ekus.
- **2026-05-05** — Hat selection: auto-detect from context only. No
  explicit toggle. Detection in Orchestrator; hats declared in Soul.
- **2026-05-05** — Prompt-flow ordering: hat auto-detect runs
  *before* classifier. Hat = which Soul flavor. Classifier = how
  much process.

-----

## Open questions parking lot

Anything raised in conversation but not yet resolved. Re-sectioned
2026-05-26 by stage.

### Stage 1

- Browser Fitting iPad keyboard handling (May 25 research flagged
  this).
- Browser Fitting context isolation — one Chromium with many named
  contexts (lean) vs separate instances per session.
- Sequoias retirement gate — closed 2026-06-11 by the Dev Env
  consolidation; Sequoias retired outright.

### Stage 2

- Evidence Faculty home — dedicated `evidence` Faculty (lean) vs
  method on Artifact Store vs validator output handling.
- Validator `consumes: automation-runner`? Probably yes.
- `/goal` under headless spawn — spike needed to confirm clean
  interaction with the May 13 tier-aware respawn shape.
- Acceptance criteria block format — markdown checkboxes with
  fenced YAML source (lean).
- Recovery loop bounds — hard cap on re-plan loops (lean: 2 then
  mandatory human).
- Audit of existing tier-classifier work and May 12 `mcp-gateway`
  brief for compatibility with two-stage classifier.
- Classifier-1 model — Haiku (lean).
- Planner artifact location — `dev-evidence/<session>/<run-id>/`
  (lean) vs project-relative `docs/plans/` vs Documents Fitting
  proper.

### Stage 3

- Web channel UX polish bar — how much before Stage 3 ships vs
  parallel iteration.
- Session-spawning permission model — unilateral for tier ≤ 2,
  asks for tier ≥ 3 (lean).
- "Take over inline" UX — how the dev-env session view surfaces the
  active orchestrator-initiated run.

### Stage 4

- "Discussion has converged" trigger — heuristic in `for_consumers`
  plus explicit user signal (lean: both).
- Document update vs new — match recent topic → update; else new
  (lean).
- Chat ↔ document boundary — chat is ephemeral, document is durable.

### Stage 5

(See deferred old Phase 8 entries. Refresh when Stage 5 gets close.)

- Trello-sync Faculty kind — new `data-sync` kind vs reuse existing
  (lean: new kind if more bidirectional syncs follow).
- Autonomy floor config — tier ≤ N runs autonomously, tier > N
  plan-then-approve.
- Multi-board / per-project task scoping when Stage 4 documents
  are reliable.
- Real-time UI push — polling for v1, SSE/websocket if needed.
- Trello-sync conflict resolution — last-write-wins by `updated`
  timestamp.

### Cross-cutting / future

- **Faculty/shape validator refactor.** Surfaced during old Phase 2
  T7 and again in Phase 3 T4. The validator conflates "what the
  operative sees" with "how the Fitting is invoked." Worth a clean
  refactor when a third exception comes up — the rule of three.
- **Documents editor: textarea → tiptap.** Pragmatic v1 ships
  textarea; upgrade path documented.
- **Documents read view: mini-renderer → full react-markdown.**
  Pragmatic v1; migrate when tables/footnotes/complex links bite.
- **Frontend view registry: static → dynamic imports.** Pragmatic
  v1; dynamic when third-party Fittings ship their own views.
- **Memory Fitting UI surface** — likely a Stage 4 or later
  follow-up. Structurally similar to Documents UI.
- **Testing & Validation Faculty (separate from Stage 2's testing
  step).** For autonomous flows. Testing consumes
  `automation-runner`. Discipline + validation logic + when-to-run
  rules.
- **Voice Faculty.** Playback + recording, channel-aware delivery.
  Reuses Artifact Store. Real-time bidirectional voice deferred.
- **Garrison-as-AI-composer (advisory/validation).** Build when
  composition complexity warrants.

### Workflow tool (parked)

Revisit only if external signals (YouTube content, community
adoption, official Anthropic documentation) indicate the feature is
worth a second look. Research artifact from 2026-05-26 is the
starting point if/when revisited.

### Outposts (deferred)

Full Phase 6 design preserved in the prior roadmap revision. Reload
when post-Stage-5 work activates this.

### Knowledge & Self-Improvement (deferred)

Full Phase 9 four-pillar placeholder preserved in the prior roadmap
revision. Reload when post-Stage-5 work activates this.
