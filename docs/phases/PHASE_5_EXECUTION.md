# Phase 5 Execution Plan — Armory

**Companion to:** `GARRISON_ROADMAP.md` — Phase 5 section. The
roadmap is source of truth for *why*; this doc is source of truth
for *what next*.

**Phase 5 outcome (from roadmap):** Garrison gains an Armory area
in the shell — a family of Faculties (each with stable contracts)
hosting Fittings that provide non-agentic tools. Verification
milestone is the Sequoias decomposition: replace the standalone
Sequoias worktree-manager app with three Armory Fittings.

**Status going in:** Phases 1–4 complete. Contract v2 from Phase 3
is in place. Setup hook from Phase 1 is in place. The platform
thesis (Faculties + Fittings, dynamic shell rendering) is the
load-bearing principle the Armory builds on directly.

**Important reframe:** Phase 5 is no longer "build Trenches as a
Garrison-core area." It's "extend the existing dynamic shell
rendering to a new family of Faculties (the Armory)." The
architectural surface is much smaller than Trenches would have
been; the Fitting work is comparable.

---

## Pre-agreed: T0 is an analysis session

The roadmap pre-agreed an analysis session at the start of Phase 5.
With the Armory reframe, T0 has more to settle than before:

- **Sequoias inventory** — what's in the standalone Sequoias app,
  what decomposes cleanly into the three Fittings
  (`worktree-management:sequoias`, `session-view:sequoias`,
  `terminal:armory-default`), what doesn't.
- **Harmonika inventory** — what's there for screen-share and any
  PTY plumbing not in Sequoias.
- **APM UI Fitting parity gap-find** — does Garrison's existing
  UI Fitting mechanism (contract v2 from Phase 3) cover what the
  Armory needs? Specifically: action declarations on Fittings,
  provides/consumes wiring through to UI components, dynamic
  shell rendering of an unbounded set of Fittings under a Faculty
  family.
- **Armory shell layout** — single-active vs tabbed-multi vs
  split-grid. Decide based on the Sequoias decomposition's natural
  shape.
- **Screen-share approach** — periodic screenshots vs full
  streaming.
- **Terminal busy-detection heuristic.**

T0 outputs `PHASE_5_ANALYSIS.md` committed to the repo. Without
it, T1+ are guessing.

---

## Cross-phase notes before we start

**1. The Armory is the first phase that introduces a *family* of
Faculties with related but distinct contracts.** Up to now,
Faculties have been singletons (Memory, Vault) or general kinds
(channels, data-sources, knowledge-base, automations, skills).
The Armory family treats Faculties as a grouped namespace. The
shell needs to know which Faculties are Armory Faculties so it can
render them in the Armory area.

**Implementation note:** likely a `family: armory` field on the
Faculty declaration in `x-garrison`. Or a Faculty registry that
flags certain Faculty kinds as Armory members. T0 picks the
mechanism. Either way, this is the first time Faculty *grouping*
matters at the platform level.

**2. The Sequoias decomposition is the verification target.** Once
all three Fittings work in Garrison and Sequoias-the-app is
retired, the Armory pattern is proven. The user already runs
Sequoias daily; replacing it is a real-stakes test.

**3. The user-scoped data dir (`~/.garrison/`) precedent.** Hosts
list lives there; per-user preferences will live there too. First
introduced in this phase; future user-scoped state follows the
same pattern.

**4. Operative-bridge to Armory tool actions is design-now-cost-
zero.** Action declarations using `provides`/`consumes` mean an
agent-skill Operative could invoke Armory tools via the same
wiring graph. v1 doesn't ship this end-to-end; the contract just
accommodates it without rework.

---

## Ordering & dependencies

```
T0: Analysis session                              ── must come first
T1: Armory shell area (Faculty family rendering)  ── needs T0 + APM gap fixes
T2: terminal Faculty + armory-default Fitting     ── needs T1
T3: worktree-management Faculty + Sequoias Fitting── needs T1 + T2
T4: session-view Faculty + Sequoias Fitting       ── needs T1 + T2 + T3
T5: terminal launch presets (Operator/Code)       ── needs T2
T6: Multi-host (Tailscale + SSH) for terminal     ── needs T2
T7: screen-share Faculty + Fitting                ── needs T0 + T1
T8: Sequoias retirement (verification milestone)  ── needs T2 + T3 + T4
T9: Phase 5 verification                          ── all
```

T0 must come first. T1 is the platform plumbing. T2 lands the most
foundational Armory Fitting (terminal — almost everything else
either depends on it or interacts with it). T3 + T4 are the
Sequoias-specific Fittings. T5 + T6 layer onto T2. T7 is
independent of the Sequoias track. T8 is the user-facing milestone
("delete Sequoias.app"). T9 is the verification document.

Realistic parallelism: after T1 lands, T2 + T7 can run in parallel.
T3 + T4 + T5 + T6 are sequential against T2.

The `browser` Faculty is **not** in the ticket list. Per roadmap
open question, lower priority; defer unless T0 finds a strong
reason.

---

## Tickets

### T0 — Analysis session

**Why:** Pre-agreed at roadmap level. The Armory reframe makes T0
load-bearing — every later ticket depends on its findings.

**Scope:**

- **Sequoias code inventory** — exact paths, dependencies,
  decomposition map. For each of:
  - Worktree management code → `worktree-management:sequoias` Fitting.
  - Session-view code → `session-view:sequoias` Fitting.
  - Terminal code → `terminal:armory-default` Fitting.
- **Harmonika code inventory** — screen-share specifically, plus
  any terminal/PTY plumbing if Sequoias's terminal needs
  augmentation.
- **APM UI Fitting parity gap-find** — read Garrison's current
  contract-v2 implementation. Does it support:
  - A Faculty that *isn't* a singleton? (Multiple Fittings
    under `terminal`, multiple under `worktree-management`, etc.)
  - Action declarations on UI Fittings via provides/consumes
    that other Fittings (and eventually Operatives) can invoke?
  - Dynamic rendering of an unbounded set of Fittings in one
    shell area, grouped by Faculty?
  - If any of these are missing, scope the gap-fix.
- **Armory shell layout** — pick:
  - Single-active (one Fitting visible at a time, switcher in
    the rail) — simplest.
  - Tabbed-multi (several Fittings open as tabs) — more like
    Sequoias's current UI.
  - Split-grid (multiple Fittings tiled) — most powerful, also
    most work.
  Pick one. Justify briefly.
- **Faculty-family mechanism** — how does the shell know a
  Faculty is an Armory Faculty? Field on the Faculty declaration?
  Registry? Convention? Pick one.
- **Screen-share approach** — periodic screenshots vs streaming.
  Pick.
- **Terminal busy-detection heuristic** — pick.
- **Default Claude Code flags** — settle the actual list.
- **Surprises to flag** — license issues, tightly-coupled
  dependencies in Sequoias/Harmonika, missing dependencies, etc.

**Output:** `PHASE_5_ANALYSIS.md` committed.

**Done when:**

- Each open question above has a paragraph-length answer.
- Decomposition map of Sequoias → three Fittings has real paths.
- APM gap-fix list, if any, is itemized.
- Surprises explicitly called out.

**Out of scope:**

- Any actual implementation. T0 is read-only.
- Comparing alternatives outside Sequoias/Harmonika.

---

### T1 — Armory shell area + Faculty-family rendering

**Why:** Roadmap Phase 5 §scope item 1. The shell needs to
recognize Armory Faculties and render their Fittings dynamically
in a dedicated area.

**Depends on:** T0 (Faculty-family mechanism, shell layout
decision, any APM gap-fixes).

**Scope:**

- **Faculty-family declaration** — implement the mechanism T0
  picked (likely a `family: armory` field on the Faculty
  declaration, or a static registry of Armory Faculty kinds in
  the shell code).
- **Seed Armory Faculties** — register the well-known kinds:
  `worktree-management`, `session-view`, `terminal`,
  `screen-share`. (Browser deferred per Phase 5 open question.)
  No Fittings yet — those are T2/T3/T4/T7. T1 just declares
  the kinds exist.
- **Armory shell area** — new top-level navigation entry in the
  Garrison sidebar called "Armory" (or whatever T0 settles).
  Renders dynamically based on installed Armory Fittings:
  - Reads the active composition's `x-garrison` block.
  - Identifies all Fittings whose Faculty is an Armory Faculty.
  - Renders each according to T0's layout decision.
- **APM gap-fixes** — implement whatever T0's gap-find surfaced
  (action declarations, dynamic rendering, multi-Fitting
  Faculties). These may be larger than T1 itself; if so, split
  into T1a (gap-fix) and T1b (Armory area on top).
- **Empty state** — when no Armory Fittings are installed in the
  composition, the area shows a helpful message ("No Armory
  Fittings installed — add `worktree-management`, `terminal`, or
  others to your composition to see them here.").
- **Code separation** — Armory shell rendering lives in
  `src/armory/` (or wherever the frontend conventions put new
  shell areas). The *Fittings themselves* live under
  `fittings/seed/` like every other Fitting.

**Done when:**

- "Armory" appears in the sidebar.
- Clicking it opens the Armory area with the empty state.
- A test Fitting declaring an Armory Faculty (a 5-line
  hello-world Fitting) renders correctly when added to a
  composition.
- Existing pages still work (Run, Components, Documents,
  Artifacts).

**Out of scope:**

- Anything terminal- or worktree-specific. T2/T3 land those.
- Cross-Fitting communication beyond what contract v2 already
  supports.
- Mobile responsive design.

---

### T2 — `terminal` Faculty + armory-default Fitting

**Why:** The most foundational Armory Fitting. Almost everything
else depends on it or interacts with it.

**Depends on:** T0 (lift inventory), T1 (Armory shell).

**Scope:**

- **`terminal` Faculty** — declared in T1 already. Stable
  contract:
  - Provides: terminal session list, active session selection.
  - Consumes: optional `worktree:current` (so worktree-management
    can drive terminal cwd).
  - Actions exposed: spawn-session, send-input, kill-session,
    list-sessions.
- **`terminal:armory-default` Fitting:**
  - New Fitting at `fittings/seed/terminal-armory-default/`.
  - Frontend: xterm.js (or Sequoias's existing terminal UI if T0
    confirms it's xterm-based). Each session = one
    `<XtermTerminal />` instance.
  - Backend: PTY layer using `node-pty` (or whatever T0
    confirms). Each session = one PTY process.
  - Multi-session: N PTYs, N WebSocket connections, N rendered
    terminals.
  - Busy/idle indicator: per the heuristic T0 settles.
  - Spawn defaults: cwd from `worktree:current` capability if
    consumed, else home dir, else `projects_root`.
  - Setup hook: install/rebuild `node-pty` against the right
    Node version. Match Garrison-core convention for native
    deps.
- **Action declarations on the Fitting** — every action above is
  declared in `apm.yml` so other Fittings (and eventually
  Operatives) can invoke them via the wiring graph.
- **`for_consumers` block** — explains how to use the terminal
  Fitting from a consumer's perspective.

**Done when:**

- Click the terminal Fitting in Armory → a real shell appears,
  accepts input, shows output in real time.
- Open multiple sessions → each independent.
- Run `sleep 5` → busy indicator on, idle when done.
- Close a session → PTY exits, no zombies.

**Out of scope:**

- Persistent sessions across restarts.
- Custom keybindings beyond xterm.js defaults.
- Tmux-style splits within a session.

---

### T3 — `worktree-management` Faculty + Sequoias Fitting

**Why:** Roadmap Phase 5 verification milestone. First of the
three Sequoias-decomposition Fittings.

**Depends on:** T1, T2 (terminal Fitting consumes worktree
selection).

**Scope:**

- **`worktree-management` Faculty:** declared in T1 already.
  Stable contract:
  - Provides: list of worktrees (path, branch, status).
  - Provides: active worktree selection (single-select).
  - Actions: create-worktree (with port allocation, startup
    commands), delete-worktree, set-active.
- **`worktree-management:sequoias` Fitting:**
  - Lift Sequoias's worktree code per T0's decomposition map.
  - Backend: git plumbing for worktrees, port allocation, startup
    command execution.
  - UI: list view, create-worktree form (path, branch, ports,
    startup commands), delete-confirmation.
  - Persistent state: `~/.garrison/worktrees/` (per-user — these
    follow the human, not the composition).
- **Action wiring with `terminal`** — when the user selects a
  worktree and clicks "Open Terminal," the worktree-management
  Fitting invokes the terminal Fitting's spawn-session action
  with `cwd` set to the worktree path.

**Done when:**

- Worktree-management Fitting appears in Armory.
- I can create a new worktree, see it listed, set it active.
- Clicking "Open Terminal" on an active worktree spawns a
  terminal in that directory.
- Existing Sequoias worktrees are visible (the Fitting reads
  the same on-disk state Sequoias uses, or migrates from it —
  T0 settles).

**Out of scope:**

- Worktree-management features Sequoias doesn't have.
- VCS-other-than-git support.
- Worktree templates.

---

### T4 — `session-view` Faculty + Sequoias Fitting

**Why:** Second Sequoias-decomposition Fitting. Surfaces what's
running across the Armory.

**Depends on:** T1, T2, T3.

**Scope:**

- **`session-view` Faculty:** stable contract:
  - Consumes: terminal session list (from `terminal`).
  - Consumes: worktree list with status (from
    `worktree-management`).
  - Provides: aggregated session state per worktree (running,
    idle, needs attention, finished).
  - Actions: open PR, kill session, refocus.
- **`session-view:sequoias` Fitting:**
  - Lift Sequoias's session-view code per T0's decomposition.
  - UI: list of worktrees with status indicators, action
    buttons.
  - Status detection: based on terminal busy/idle (from T2's
    heuristic) plus Sequoias-specific signals (process
    activity, file changes, etc.).
- **Cross-Fitting wiring** — session-view consumes from both
  terminal and worktree-management; this exercises contract v2's
  multi-consume capability.

**Done when:**

- Session-view Fitting appears in Armory.
- All worktrees show with current status.
- Status updates live as terminals go busy/idle.
- "Open PR" / "Kill" / "Refocus" actions work end-to-end.

**Out of scope:**

- Status signals beyond what Sequoias already has.
- Notification system (push notifications, system tray).

---

### T5 — Terminal launch presets (Open Orchestrator / Open Claude Code)

**Why:** Roadmap Phase 5 §scope item 5. Quick-launch as actions on
the `terminal` Fitting, not a separate Fitting.

**Depends on:** T2.

**Scope:**

- Add two action declarations to `terminal:armory-default`:
  - `launch-orchestrator` — spawns a session with `claude
    --append-system-prompt $(cat <assembled-prompt>)` in
    Garrison's working directory.
  - `launch-claude-code` — spawns a session with `claude
    <default-flags>` at a chosen path.
- UI: action buttons in the terminal Fitting's toolbar (or a
  dropdown menu for "New session ▾").
- Default flags: from Garrison settings (per-user). Default
  `--dangerously-skip-permissions` per the leaning; T0 settles
  any additions.
- Path picker for launch-claude-code: free-text field defaulting
  to `${projects_root}/`. No file-explorer dialog (deferred).
- Banner injection: when launch-orchestrator spawns, the
  terminal session's first output is a Garrison-injected banner
  explaining "this terminal is a separate session from chat;
  shares memory but not turn history."

**Done when:**

- Click "Open Orchestrator" → terminal opens with Claude Code
  running, system-prompted as the Operative, banner shows.
- Click "Open Claude Code" → typed path → terminal opens with
  plain Claude Code in that directory.

**Out of scope:**

- File-explorer dialog.
- History of recently-launched paths.

---

### T6 — Multi-host (Tailscale + SSH)

**Why:** Roadmap Phase 5 §scope item 6.

**Depends on:** T2, T5.

**Scope:**

- **Hosts file:** `~/.garrison/hosts.json`. Schema:
  ```json
  [
    { "name": "mac-mini", "address": "100.x.y.z", "user": "ggomes" }
  ]
  ```
- **Hosts CRUD UI:** Garrison settings (or Armory-area-specific
  settings panel). Add/edit/delete hosts.
- **Host selector** — appears on the terminal Fitting. Default
  local. Dropdown lists local + hosts.json entries.
- **Remote terminal launch** — when remote host selected, the
  spawn becomes:
  ```
  ssh -t <user>@<address>
  ```
- **Remote Claude Code launch** — same SSH wrapper around the
  launch-claude-code action.
- **Operator-aware actions are local-only** — launch-orchestrator
  is disabled when a remote host is selected (assembled prompt
  is local).
- **SSH auth** — trust user's SSH config, no key management.

**Done when:**

- Add a host via settings → persists.
- Select host, click New Terminal → SSH'd shell.
- Open Claude Code remote → typed path → Claude Code runs on
  remote.
- Open Orchestrator disabled when remote selected.

**Out of scope:**

- Tailscale auto-discovery.
- Connection pooling.
- Auth beyond SSH key.

---

### T7 — `screen-share` Faculty + Fitting

**Why:** Roadmap Phase 5 §scope item screen-share. Watch desktop
from a phone or another machine.

**Depends on:** T0 (approach decision), T1.

**Scope:**

- **`screen-share` Faculty:** declared in T1.
  - Provides: capture stream / frame URL.
  - Actions: start-capture, stop-capture, send-event (mouse/
    keyboard for screenshot variant).
- **`screen-share:default` Fitting:**
  - Lift Harmonika's existing implementation per T0.
  - Backend: depends on T0 — periodic screenshots or streaming.
  - UI: live view in Armory area, start/stop button, capture
    rate indicator.
- **macOS Screen Recording permission** — setup hook detects
  missing permission and tells user to grant via System
  Settings; can't automate.
- **Local-only for v1** — remote screen-share moot per roadmap.

**Done when:**

- Click screen-share Fitting → live desktop view.
- Open Garrison from phone → see same screen-share.
- Mouse/keyboard relay (if screenshot variant) works.
- Stop button cleanly tears down capture.

**Out of scope:**

- Audio.
- Multi-monitor.
- Recording to disk.
- Cross-platform.

---

### T8 — Sequoias retirement (verification milestone)

**Why:** The actual phase verification — Sequoias the standalone
app gets retired in favor of the Armory composition.

**Depends on:** T2, T3, T4.

**Scope:**

- Use Garrison-with-Armory for one full day of normal worktree-
  driven work.
- Compare against Sequoias for the same workflow.
- Identify any gaps that would prevent retirement; if found,
  scope a fast follow-up.
- Once gaps are closed, formally retire Sequoias:
  - Stop running Sequoias's process.
  - Document the retirement in a `SEQUOIAS_RETIREMENT.md` (or
    similar) file with the date, reason, and migration notes.
  - Optionally: archive Sequoias's repo with a README
    redirecting to Garrison.

**Done when:**

- I haven't opened Sequoias for at least 3 consecutive working
  days.
- Garrison's Armory composition handles all my worktree-driven
  work.

**Out of scope:**

- Migrating other people's Sequoias usage (you're the only
  user).
- Archiving Sequoias's repo on a public host.

---

### T9 — Phase 5 verification

**Why:** Walk the Phase 5 done-when checklist and document.

**Depends on:** T1–T8.

**Scope:**

Walk the six roadmap done-when items:

1. Armory shows three Sequoias-derived Fittings under the active
   composition.
2. Create worktree → appears in session-view → click to open
   terminal in that directory.
3. Three independent terminals, busy/idle visible via session-view.
4. SSH-launch terminal on Tailscale host.
5. Phone view of screen-share Fitting.
6. Sequoias retired in favor of Armory.

`PHASE5_VERIFICATION.md` mirrors prior phases.

**Done when:**

- All six items pass.
- `PHASE5_VERIFICATION.md` committed.

---

## What gets carried into Phase 6 / future phases

- **Operative bridge** (working, end-to-end invocation of Armory
  actions from agent-skill Operatives) — design-now-cost-zero in
  Phase 5; build in Phase 6 or later when there's a concrete need.
- **Persistent sessions across restarts.** Defer.
- **Browser Faculty + Fitting** — deferred from Phase 5; add when
  there's a concrete tool to host (Excel-for-web, dashboard, etc.).
- **Linux/Windows screen-share** — when platform thesis pushes
  beyond macOS.
- **Public marketplace for Armory Fittings** — Phase 6+ if at all,
  per roadmap out-of-scope.

---

## What still needs an answer before T1 can ship

- **T0's analysis output.** All other tickets reference T0's
  decisions. Don't start T1 until T0 has produced
  `PHASE_5_ANALYSIS.md`.

That's it. Once T0 lands, T1–T9 proceed cleanly.
