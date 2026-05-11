# Garrison Roadmap

**Status:** Live working document. Edited during planning conversations.
This is the source of truth for Garrison's phased roadmap — not just
the personal-assistant feature set that started it, but every feature
being planned for the platform.
**Goal:** Get Garrison to the point where it replaces claude.ai for
PM/architect-style discussions, manages tasks via Trello, runs
heartbeat-driven autonomous suggestions, can spawn coding work on real
projects, and eventually owns the EKOA-style Automations as a Faculty.

---

## North star

A single Operative running locally that:

1. I can talk to from desktop **and** Slack.
2. Acts as PM + Software Architect when I'm discussing a project (or
   any other hat I configure into the Soul).
3. Knows where my projects live and can read them for context without
   me pasting GitHub sources.
4. Remembers things across sessions via the Memory Faculty (the
   user's existing Obsidian-backed memory-compiler with Claude Code
   hooks).
5. Looks at its task list on its heartbeat, suggests what to work
   on, and — once I trust it — does autonomous tier-1/2 work.
   Tasks live in a first-party Tasks Faculty with a Kanban UI; the
   board doubles as the visible control plane for autonomous work.
   Trello (and other external trackers) sync optionally.
6. Builds documents alongside conversations the way claude.ai does
   — the PM/Architect hat captures decisions and plans into a
   browsable, editable markdown corpus without me asking. All
   artifacts the Operative produces (documents now, automation
   videos and voice audio later) live in a unified Artifact Store
   browsable from one place.
7. Plans features via Claude Code's planning tool, asks me to approve,
   then executes them in the right project folder, in the right
   session shape.
8. Gives me a tooling surface (the Workbench) where worktrees,
   sessions, terminals, screen sharing, and other tools compose
   the same way agentic primitives do — Faculties and Fittings,
   wired by provides/consumes. The Sequoias worktree-manager
   becomes three Workbench Fittings rather than a separate app.
9. Reaches across all my Macs via the Outposts Faculty: I sit
   at any machine, Garrison runs on the always-on host, the
   Operative orchestrates work on whichever machine the work
   actually lives on. Worktrees, terminals, file operations,
   vault sync — all flow through a small bridge per remote
   machine, no second Garrison instance needed.
10. Runs and self-improves browser automations (Playwright-based, ported
    from EKOA) with a UI surface where I can fix, replay, and feedback.
11. Treats the Kanban board as a control plane: I add a card,
    the Operative picks it up; I drag a card, the Operative reacts.
    Foundation for genuinely autonomous workflows where one operator
    runs a software project — or a small business — through their
    Operative.

Phases below are **scoping containers**, not strict gates.

---

## Cross-cutting: settled context

These are not phase items, just things to keep in mind across the work.

- **Reference projects, sibling folders.**
  - **`awc-gateway-slack`** (`~/Projects/awc-gateway-slack/`) — the
    real source of the Slack channel and a clean channel-agnostic
    HTTP gateway. Pure stdlib Node 20+. 354-line slack-adapter.js +
    146-line gateway.js + SessionStop hook. This is the
    prior-art for both `fittings/seed/slack-channel` and a slimmer
    `fittings/seed/http-gateway`.
  - **Ekus** (`~/Projects/ekus/`) — has the **Trello client** worth
    porting (`mac-mini/gateway/heartbeat/trello.py`, real REST
    client) and a Trello agent skill. Ekus's *gateway* (2090-line
    FastAPI doing jobs+automation+scheduler+voice+whatsapp+...) is
    too coupled for Phase 1 — lift patterns only when needed.
    Ekus's "Slack" is poll-based curl from inside a session, not an
    inbound webhook — **not what we want**.
  - **`~/.claude/memory-compiler/`** — the user's existing working
    memory compiler. Python (uv), three Claude Code hooks
    (SessionStart / SessionEnd / PreCompact), compile script that
    extracts atomic articles via the Anthropic API into the Obsidian
    vault at `~/Projects/ekus/obsidian-vault/Compiled/`. This is
    what the Memory Fitting wraps. Already alive on this machine.
  - **EKOA** (`~/Projects/ekoa-dev/`) — Phase 7 only. Has *two*
    automation engines: `cortex/` (Playwright in-process) and
    `automato/` (raw CDP via chrome-remote-interface). Phase 7 has
    to pick before porting. UI is Next.js 16 + React 19 at
    `ekoa/app/(dashboard)/automations/`.
  - **Sequoias** (sibling project on this machine) — Phase 5
    primary reference. Standalone Next.js worktree-manager app.
    Decomposes into three Workbench Fittings (`worktree-management`,
    `session-view`, `terminal`) under the Sequoias decomposition
    verification milestone. Once the Workbench composition works,
    Sequoias is retired in favor of those three Fittings.
    **Sequoias also has multi-machine support** (its own bridge
    pattern) which Phase 5's Workbench port intentionally left out;
    Phase 6 (Outposts) restores that capability as a proper
    Faculty rather than a Sequoias-specific feature.
  - **Three Macs on Tailscale:** the **automation machine** (Mac
    Mini M4, 16 GB, always on — hosts Garrison + Operative), the
    **development machine** (MacBook Pro M1 Max, 32 GB, always on
    — primary code work), and the **portable machine** (MacBook
    Air M4, 16 GB, intermittent uptime — carried around). Phase 6
    Outposts wires these together; before Phase 6, Garrison is
    single-machine.
  - **Harmonika** (sibling project on this machine) — Phase 5
    secondary reference. Source of the screen-share
    implementation and any terminal/PTY plumbing not already
    available in Sequoias. Same tech stack as Garrison; lift
    wholesale rather than reimplementing.
- **Runtime is the SDK gateway, not `claude` spawn.** The HTTP gateway
  uses `@anthropic-ai/claude-agent-sdk` in-process and resumes the
  same session by id. Auth is the Max account; no API key billing.
- **Orchestrator + Soul concatenation already works.** The runner
  reads both prompt files and writes `assembled-system-prompt.md`,
  passed to the SDK as `append`.
- **Permission mode is `bypassPermissions` for now.** Anything stricter
  hangs because the UI has no permission-prompt surface yet.
- **No multi-host compositions in v1.** One composition per host.
  Slack will be an inbound channel pointed at the same Operative.
- **Faculties terminology:** Faculties (slots), Fittings (concrete
  components in slots), Operative (the agent), Garrison (the
  platform). Stay consistent.

---

## Cross-cutting: the `setup` hook (new Fitting lifecycle stage)

**Decided 2026-05-05.** Garrison gains a new Fitting lifecycle stage:
`setup`. It runs *before* `verify` on every `up`, and is the standard
mechanism for Fittings whose prerequisites can't be satisfied by APM
alone (clone a repo, run `uv sync`, write to host-level config,
install a browser binary, set up a tunnel).

### Shape

In `x-garrison`:

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

### Runner behavior (added to runner.ts)

On `up(composition)`, after `apm install` and before `verify`:

1. For each selected Fitting with a `setup` block:
   - Run `setup.command` in the Fitting's installed directory.
   - Capture stdout/stderr to the composition log.
   - On non-zero exit, log and **abort `up`** (don't pretend the
     Fitting started).
2. Then run `verify` as today.

### Spec changes needed

- `METADATA.md` — add `setup` to the top-level `x-garrison` schema
  table, schema same shape as `verify`.
- `AGENTS.md` §5 — extend the runner responsibilities to mention
  setup-before-verify.
- `V1_DOD.md` — add an observable item: "Fittings with a setup
  block run their setup script on every `up`, before verify, and a
  failing setup aborts the run."
- One test in `tests/runner.test.ts` (or wherever runner tests live)
  proving the ordering.

### Why a new hook, not extending `verify`

`verify` is read-only by contract — "is this Fitting in a healthy
state?" Mixing in side-effect-causing setup logic muddies that
contract. Keep them distinct: setup makes the world right, verify
checks it. Lets the user run `verify` standalone any time without
fear it'll mutate things.

### Authoring guidance for Fittings using setup

- Setup scripts must be idempotent in practice, regardless of the
  flag.
- Setup should fail loudly with clear messages, never silently no-op.
- Setup may ask for user attention via stdout (e.g. "open
  https://api.slack.com/apps and copy your signing secret into the
  vault, then re-run") but cannot block on stdin — the runner
  doesn't pipe a TTY.
- Anything requiring user interaction belongs in
  `manual-instructions` or a UI extension, not setup.

---

## Cross-cutting: Garrison-as-AI-composer (future direction)

**Status:** captured, not yet phased. Build advisory/validation
version when there's a concrete need for it.

### The idea

Garrison today is purely deterministic: read manifests, resolve
the capability graph, install Fittings, concatenate prompts, run
the Operative. An AI-composer adds an LLM-assisted step at compose
or apply time that reasons about the composition and either
*advises the human* (option a) or *generates artifacts directly*
(option b).

### Two flavors

- **Option (a) — advisory/validation.** Composition stays
  deterministic. An assembler agent runs at apply time (or on
  user request), reads the selected Fittings + their `for_consumers`
  + soul + orchestrator + capability graph, and produces:
  - Warnings ("two providers of `channel:slack` — pick one").
  - Recommendations ("you have Trello but no Memory; consider
    adding garrison-memory").
  - Friction reports ("the Soul says terse, but the Documents
    `for_consumers` asks for verbose link previews — you may want
    to reconcile").
  - The human accepts or rejects. The composition itself stays
    code+YAML.

- **Option (b) — synthesis.** The runner asks an LLM to *write*
  the assembled system prompt by reasoning over inputs, not just
  concatenating them. Risks: non-reproducibility (same composition
  → different prompts), cost (every apply hits an LLM),
  debuggability (one more layer between intent and behavior).
  **Not recommended for the foreseeable future.** Solve a real
  problem first; pull this in only if (a) doesn't.

### When to build (a)

Don't build speculatively. Build when one or more of:

- Compositions get big enough that the human can't reason about
  them unaided.
- `for_consumers` blocks start contradicting each other in ways
  the runner can't detect statically.
- A meaningful number of Fittings exist in the registry and
  novice users need help picking compatible sets.
- Users start asking "did I miss something obvious?" when
  composing.

### Tracked as

A future phase, exact number TBD. Likely lands sometime after
Phase 7, when the Fitting registry has enough breadth that
composition complexity is real.

---

## Phase 1 — Make the seed Operative actually personal-assistant-shaped — **DONE (2026-05-06)**

**Status:** Complete. Tickets T1–T9 from `PHASE_1_EXECUTION.md`
all landed. The Operative has Gateway, Memory (via the cloned
`~/.claude/memory-compiler/`), Soul, Orchestrator (with capability-
graph composition awareness via `cardinality: any`), Classifier,
Heartbeat (off by default), Trello, and Slack channel. Reachable
from phone via Slack. The runtime composition-awareness assertion
(operative lists/de-lists Trello based on selection) passed.

**Outcome:** I can hit Run, get a single Operative that has the right
core Faculties wired up (Gateway, Memory, Soul, Orchestrator,
Classifier, Heartbeat, Trello, Slack), and reach it from my phone via
Slack. It doesn't yet do anything clever — it just *exists in the
right shape* with real memory and a real channel.

### Scope

1. **Audit the current seed Fittings against personal-assistant needs.**
   Six exist: heartbeat, classifier, memory, gateway, browser-automation,
   trello-data-source. Walk each one and decide: keep / extend / replace.
2. **Memory Faculty wraps the existing `~/.claude/memory-compiler/`,
   installed via the new `setup` hook.**
   - The user has a working memory compiler at
     `~/.claude/memory-compiler/` (Python, three Claude Code hooks,
     compile script, Anthropic API extraction into the Obsidian
     vault at `~/Projects/ekus/obsidian-vault/Compiled/`). The
     SessionStart hook already injects `index.md` as
     `[Knowledge Base]` into every Claude Code session on this
     machine.
   - **The compiler is its own GitHub repo** (URL: TBD — user to
     share). The seed `fittings/seed/memory` does *not* bundle the
     compiler. It bundles a setup script that clones it on demand.
   - **Setup script behavior** (`fittings/seed/memory/scripts/setup.sh`):
     1. If `~/.claude/memory-compiler/` exists, skip clone.
     2. Else `git clone <compiler-repo> ~/.claude/memory-compiler`.
     3. Run `uv sync --directory ~/.claude/memory-compiler` (idempotent).
     4. Read `~/.claude/settings.json`. If the SessionStart /
        SessionEnd / PreCompact hook entries are missing, add them
        (matching the existing entries documented in the
        investigation report). If present, leave alone.
     5. Resolve `$COMPILER_OUTPUT_DIR` — if not set, default to
        `~/Projects/ekus/obsidian-vault/Compiled` so the existing
        compiled memory is reused.
     6. Exit 0.
   - **Verify hook** (post-setup): all three hooks resolve, the
     compile script exists, `uv sync` succeeded, output directory
     is reachable.
   - **Manifest schema fix:** rename `compiled_memory_path` →
     `compiled_memory_dir`. The compiler writes a directory tree
     (`{concepts,procedures,gotchas}/<slug>.md` plus `index.md`),
     not a single file.
   - **Claude Code's separate auto-memory** at
     `~/.claude/projects/.../memory/MEMORY.md` is left alone. The
     Memory Faculty is cardinality `single`; this Fitting wraps the
     compiler only.
   - Wire via the `memory-store:garrison-memory` capability so the
     Orchestrator consumes it. (Already declared.)
   - **Context-bloat concern (Orchestrator-side, not Fitting-side):**
     SessionStart already injects only `index.md`, not all articles.
     The Orchestrator prompt should know "you have a query helper
     that fetches specific articles by slug or keyword when you need
     more than the index" so the model doesn't try to remember
     everything from the index alone, and doesn't request the whole
     compiled corpus into context unnecessarily. Add this to the
     Orchestrator rewrite (item 6).
3. **Slack channel Fitting (port from `~/Projects/awc-gateway-slack/`).**
   - This is the real prior art. **Not Ekus** — Ekus only does
     poll-based curl from inside a session, not inbound webhooks.
   - **What's there to port:**
     - `slack-adapter.js` (354 lines) — HTTP server on
       `127.0.0.1:9512`, route `POST /slack/events`, signature
       verification (HMAC-SHA256 with `SLACK_SIGNING_SECRET`,
       5-minute replay window, `crypto.timingSafeEqual`),
       url_verification challenge echo, immediate 200 to suppress
       Slack retries, async event handling, bot-echo filter, mention
       token strip, `reply_to = "slack:<channel>:<thread_ts>"`.
     - Outbound: long-lived SSE subscriber to gateway's
       `GET /events`, posts via `chat.postMessage` with
       threading. Retry: exponential backoff with 429 retry-after
       handling.
   - **Faculty:** `channels`, shape: `script`. Runs as a child
     process spawned by the runner.
   - **Vault keys:** `SLACK_BOT_TOKEN` (xoxb-), `SLACK_SIGNING_SECRET`.
     Both required at startup; process exits 1 if missing.
   - **Public URL strategy:** instructions document one of ngrok,
     Tailscale Funnel, or `cloudflared tunnel` pointed at
     `127.0.0.1:9512`. Manual step in v1; documented, not automated.
   - **Verify hook:** `curl -fsS http://127.0.0.1:9512/health`.
4. **Verify Trello integration end-to-end — and replace the stub.**
   - Current `fittings/seed/trello-data-source/scripts/trello-sync.mjs`
     is a 4-line stub that prints a JSON line. Not a real client.
   - Port `mac-mini/gateway/heartbeat/trello.py` from Ekus (144-line
     stdlib REST client: `Card` dataclass, `TrelloClient` with
     list/create/update/comment/label methods, URL-encoding,
     pagination). Drop the `from . import config` dependency, swap
     to env vars or vault lookup.
   - Port the agent skill from `~/Projects/ekus/.claude/skills/trello/SKILL.md`
     (curl-style instructions, "A Fazer" / "Brevemente" semantics,
     Portuguese URL-encoding gotchas) into the Fitting's
     `.apm/skills/`.
   - Confirm derived Tasks surface still resolves Trello-backed
     after the port.

4a. **Swap `http-gateway` to the awc-gateway-slack pattern.**
   - The current `http-gateway` Fitting may not cleanly support the
     Slack adapter's expected SSE endpoint pattern (long-lived
     subscriber on `GET /events`, FIFO pairing on `/inbound`).
     Inventory it; if it's already the right shape, skip. Otherwise
     port the 146-line `gateway.js` from `awc-gateway-slack` as the
     Fitting's body — pure stdlib Node, channel-agnostic, FIFO
     pairing, in-memory queue.
   - **Do not** lift Ekus's 2090-line FastAPI gateway. It's doing
     twelve unrelated things at once.
   - Patterns from Ekus worth lifting **only when needed later**:
     channel session-state machine (active/starting/switching/ready
     with message_queue flush), WebSocket + polling fallback for
     non-CLI clients, per-session JSONL history at
     `data/channel-history/<session_id>.jsonl`.
5. **Soul: a real one, not the placeholder.**
   - Replace the dogfood placeholder soul with a real persona that
     encodes:
     - PM hat (clarifying questions, scope discipline, refusing to
       write code in chat when the right answer is to plan).
     - Software Architect hat (system thinking, calling out
       tradeoffs, pushing back on premature decisions).
     - Personal-assistant baseline tone for non-dev work.
   - **Hat selection: auto-detect from context.** Project mentioned
     → dev hat (PM + Architect blended). Otherwise → personal
     assistant tone. No explicit toggle in v1; if the auto-detect
     misfires often we revisit.
   - Detection signals (Orchestrator-level, not Soul-level):
     - Known project name from the projects index (Phase 2 makes this
       solid; Phase 1 can use a simpler heuristic — explicit project
       reference, code paste, file path mention).
     - Code in the message.
     - Explicit dev-flavored verbs ("plan", "implement", "fix",
       "refactor", "design").
   - The Soul declares the hats exist and what each one sounds like.
     The Orchestrator owns the *detection logic and switching*. Soul
     = who, Orchestrator = how.
6. **Orchestrator: replace the placeholder with one that owns global
   config properly *and* learns the composition by capability.**
   - `projects_root` becomes a *real* config field, populated from
     the UI.
   - Add `personas` config (list of hats it can wear).
   - Add `default_classifier_floor` (already exists implicitly).
   - **Composition awareness via the capability graph, not
     hardcoding.** The Orchestrator declares one consumes entry per
     capability kind with `cardinality: any`. Concretely:
     ```yaml
     consumes:
       - { kind: agent-skill,        cardinality: any }
       - { kind: memory-store,       cardinality: any }
       - { kind: automation-runner,  cardinality: any }
       - { kind: vault,              cardinality: optional-one }
     ```
     At assembly time, the runner walks the resolver's
     `consumer.matched` arrays, gathers everything provided in this
     composition, and injects a "tools/Faculties available in this
     Operative" block into the system prompt.
   - The Orchestrator stays a single generic Fitting. Adding a new
     Fitting to a composition automatically shows up in the
     Orchestrator's awareness — no Garrison code change, no
     per-composition prompt fork.
   - **Prompt-flow ordering (explicit in the Orchestrator prompt):**
     1. Auto-detect hat (dev vs PA) — based on intent verbs and
        project signals. Sets *which Soul flavor* applies.
     2. Classifier runs — sets *how much process* applies (T1–2
        execute, T3+ plan-then-route).
     3. Execute through the resolved Faculties.
     Hat-detection and classification are orthogonal and run in that
     order.
   - **Memory usage discipline (Orchestrator prompt content):**
     `[Knowledge Base]` is injected at SessionStart with only the
     `index.md`. The Orchestrator prompt instructs:
     - Treat the index as a map, not a knowledge dump. Don't try to
       recite from it.
     - When more detail is needed, query the compiled memory by slug
       or keyword via the memory query helper
       (`scripts/query.py` exposed as a skill or tool).
     - Don't pull the full compiled corpus into context. The index
       is enough to know *what's there*; query for specifics on
       demand.

7. **Capability resolver wildcard — already exists, just patch the
   spec doc.**
   - Investigation confirmed `cardinality: "any"` is wired
     end-to-end: parser (`metadata.ts:43`), resolver
     (`capabilities.ts:91-121`, fallthrough branch), types, tests.
     `tests/capabilities.test.ts:120-137` proves "any cardinality
     never errors regardless of provider count."
   - Phase 1 work here collapses to:
     - One-line patch in `CAPABILITIES.md` to name the literal token
       `any` (currently the doc says "all available" without
       mentioning the cardinality value).
     - Optional cleanup: make `capabilities.ts:91-121` an explicit
       `else if (cardinality === "any")` branch instead of
       fallthrough. Functionally fine today but fragile if a fourth
       cardinality is ever added.
   - The Orchestrator can declare `consumes: { kind: ..., cardinality: any }`
     for each capability kind it wants to discover. No spec change
     needed.

### Phase 1 done when

- Slack message → Operative receives it → Orchestrator system prompt
  is in effect → Memory hook fires and reads existing compiled memory
  → Reply comes back to Slack.
- I can say "what do you remember about me" and get a real answer.
- Trello data source surfaces my tasks list to the Operative.
- **Composition awareness verified at runtime:** with Trello
  selected, asking the Operative "what tools/Faculties do you have
  available?" lists Trello among them. With Trello removed and
  Operative re-run, the same question no longer lists Trello. Proves
  the capability injection actually fires at assembly.
- Heartbeat is *off* by default at this point — we don't want it
  acting until Phase 2 says it can.

### Open questions for Phase 1

- **Memory compiler repo URL** — user to share. Setup script needs
  it before Phase 1 ships.
- **Memory schema rename** confirmed: `compiled_memory_path` →
  `compiled_memory_dir`. (Captured below; remove once implemented.)
- **Slack public URL:** ngrok / Tailscale Funnel / `cloudflared
  tunnel`. Pick one for the docs and the verify script. Cloudflare is
  the most common in this user's setup; leaning that way.
- **awc-gateway-slack also has a SessionStop hook
  (`hooks/stop-to-gateway.sh`) referenced in `.claude/settings.json`.**
  Likely Phase 1 — without it, the channel pairing doesn't tick.
  Confirm during the port.
- **Setup hook spec details:** does `setup` belong only at the
  Fitting level, or should compositions also be able to declare a
  composition-level setup? Phase 1 only needs Fitting-level. Leave
  composition-level for later.

---

## Phase 2 — Real personal-assistant functionality

**Outcome:** The Operative is useful day-to-day. It picks up Trello
tasks on its heartbeat, suggests what I should do, knows about my
projects without me pasting code, and starts replacing my claude.ai
PM/architect conversations.

### Scope

1. **Project awareness via Orchestrator config.**
   - `projects_root` (already added in Phase 1) is the folder Garrison
     scans.
   - On startup or on demand, the Orchestrator builds an *index* of
     projects in that folder: project name, README excerpt, top-level
     directory layout, presence of CLAUDE.md / docs / etc.
   - The index is *known about*, not eagerly read. When I mention a
     project name, the Orchestrator knows where to look. It pulls
     content into context only when needed, not preemptively.
   - This needs a **new Faculty Fitting** under `knowledge-base` —
     call it `projects-index` or similar. Seed Fitting, shape: `skill`
     or `script` that exposes a structured "list/look-into project X"
     interface to the Orchestrator.
2. **Two-hat behavior, properly.**
   - In Phase 1 the Orchestrator already auto-detects dev vs. PA
     context using simple signals (project name, code, dev verbs).
   - Phase 2 strengthens detection by hooking it into the **project
     index**: if the user mentions any string that resolves against
     the index, dev hat engages with that project as context.
   - Both hats share the same memory and same Trello access.
   - Still no explicit user-driven toggle. If misfires accumulate,
     reopen the decision.
3. **Heartbeat-driven task awareness.**
   - Re-enable Heartbeat (loop variant) at a sensible cadence (40 min
     by default).
   - On each tick: read Trello tasks, decide if any are tier-1/2
     (cheap, low-risk, well-scoped) and could be auto-suggested.
   - **No autonomous execution yet.** The heartbeat *posts a
     suggestion* via Slack: "I think you should work on X today
     because Y, and I could do Z autonomously if you approve."
   - When I approve, it produces a plan (still no code execution
     yet — that's Phase 4).
4. **Scheduler Faculty wired up.**
   - New Fitting under `fittings/seed/scheduler` — currently empty in
     the seed set. Cron-style for non-heartbeat scheduled work.
   - First job: Google Calendar sync (see below).
5. **Google Calendar integration.**
   - New Fitting under `data-sources` (or `automations` — see open
     question): `google-calendar`.
   - Read events into the same Tasks markdown truth file (or a
     parallel one), so the Operative has a unified daily view: Trello
     tasks + calendar events.
   - Two-way: when the Scheduler creates a calendar event, sync it
     back to Google Calendar.
6. **Memory gets exercised.**
   - Make sure the memory compiler runs on its declared cadence
     (`session | daily | on_bits` from EKOA).
   - Verify decisions made in conversation actually land in the
     compiled markdown.

### Phase 2 done when

- I open Slack in the morning, the Operative tells me what's on my
  plate today (Trello + Calendar combined), and proposes one or two
  things to start with.
- I can say "let's discuss the Garrison Workspace Faculty" and get a
  real PM/architect-flavored conversation that already knows what
  Garrison is and where its docs live, without me pasting anything.
- Memory entries from the conversation appear in the compiled memory
  file by end of session.
- Calendar events I create via the Operative appear in Google
  Calendar.

### Open questions for Phase 2

- **Project-index scope:** how deep does it index? README + tree only?
  Or also CLAUDE.md, docs/*, etc.? Leaning toward "shallow by default,
  drill in on demand" to keep context window clean.
- **Calendar Faculty:** `data-sources` or `automations`? It's
  bidirectional, which the spec says is v1.2-only for data sources.
  Possible answer: it's a **data source** for read, **automation** for
  write, until two-way data sources land. Or just call it an
  automation outright since we're already breaking the read-only data
  source rule for our own use.
- **Tier classifier behavior on heartbeat-triggered tasks:** does it
  even apply, or is heartbeat work a separate routing path? Probably
  the same path — heartbeat dispatches a synthetic prompt through the
  classifier like any other entry point.
- **Approval surface:** Slack message with buttons? Slack DM with
  text reply? Reply in same thread? Threads are the cleanest — start
  there.

---

## Phase 3 — Documents Fitting + Artifact Store + UI contract v2 — **DONE (2026-05-08)**

**Status:** Complete. Tickets T1–T6 from `PHASE_3_EXECUTION.md`
all landed across commits `d22b384` (for_consumers), `7369d03`
(UI contract v2), `efcd599` (Artifact Store), `e79d28f` (Documents),
`947b1a3` and `434cff7` (verification). 133 tests pass. Three
implementation adaptations documented in the decision log:
static view registry instead of dynamic import; `cli-skill` shape
now valid under `knowledge-base` Faculty (minimal validator change,
not full refactor); edit view is textarea, not tiptap (upgrade
path documented).

**Outcome:** Three layered additions, scoped together because they
share a UI surface, a release window, and several spec changes:

1. An **Artifact Store Faculty** that underlies any Fitting which
   produces files for the user — documents now, automation videos
   later, voice audio later. Provides storage, browsing UI, and
   channel-aware link generation.
2. A **Documents Fitting** under the `knowledge-base` Faculty,
   layered on the Artifact Store, that gives the Operative a place
   to author, view, and edit markdown documents during
   conversation — the way claude.ai maintains a working artifact
   across a conversation. The PM / Software Architect hat learns
   to produce documents proactively when a discussion has
   converged on something worth capturing, without explicit
   prompting.
3. **UI extension contract v2** (multi-view Fittings, placement,
   in-Fitting routing, cross-tab linking via `garrison://`) — the
   contract redesign that was scheduled for Phase 7 (Automations).
   The Artifact Store browser + Documents editor are the two
   forcing functions, brought together here.

### Why now (not Phase 7, not Garrison-core)

- **Not Garrison-core:** documents are a specific use case, not
  every Operative needs them. Putting documents in core would
  bloat Garrison and assume too much about how people use their
  Operatives. Fitting keeps it optional.
- **Not Phase 7:** waiting to build documents until Automations
  forces the UI redesign is artificial. The need is real now.
- **Bringing the UI contract redesign forward is a calendar
  shift, not a scope addition.** That work was already going to
  happen at Phase 7. Documents drives the requirements concretely
  instead of speculatively.

### Scope

1. **`for_consumers` field on Fittings (provider-side usage
   instructions).**
   - New optional field in `x-garrison`: free-form markdown text
     telling consumers (typically the Orchestrator) how to use this
     Fitting. Locality principle: the Fitting that ships a
     capability also ships the doc on how to use it.
   - Schema:
     ```yaml
     x-garrison:
       faculty: knowledge-base
       provides:
         - kind: knowledge-base
           name: project-documents
       for_consumers: |
         You have access to a Documents workspace. Use it when:
         - In PM/Architect hat and a discussion has converged on
           something worth capturing.
         - The user explicitly asks you to write something down.

         Tools: list_documents, read_document, create_document,
         update_document. Reply with garrison://documents/<id>
         links so the user can click through.
     ```
   - **Runner assembly extension** (extends T8's assembly logic
     from Phase 1): when rendering the Orchestrator's "tools and
     Faculties available" block, include each provider's
     `for_consumers` text under its line. Fall back to `summary`
     if no `for_consumers` is set.
   - **Spec changes:**
     - `METADATA.md` — add `for_consumers` to the `x-garrison`
       schema table.
     - `CAPABILITIES.md` — note the convention: providers SHOULD
       ship `for_consumers` for any non-obvious usage.
     - `AGENTS.md` §5 — extend the runner's assembly description.
   - **Why this lands now (Phase 3) and not Phase 1:** Phase 1's
     Fittings (Slack, Trello, Memory) are mostly invoked via well-
     known patterns (channel = inbound/outbound; data-source = read);
     they don't need much usage guidance. Documents is the first
     Fitting where *when* to use it matters as much as *how* —
     proactive document creation, knowing when the conversation
     converged. Documents drives the requirement.
   - **Phase 1 Fittings get retrofitted opportunistically.** Trello
     gets a `for_consumers` block when someone wants to add
     "prefer creating cards in 'A Fazer' for active work" guidance.
     Slack gets one when threading rules need to be encoded. Not
     forced.

2. **UI extension contract v2.**
   - Extend the v1 contract (single React component per Faculty
     tab) to support:
     - **Multiple views per Fitting.** A Fitting declares N views
       in its `x-garrison.ui` block, each with a route fragment.
     - **Placement:** `faculty-tab` (renders inside the Faculty's
       pane, today's behavior) or `sidebar-surface` (renders as a
       full Garrison surface in the left nav, alongside Run /
       Components / Workbench). Documents will use
       `sidebar-surface` since it's a workspace, not a Faculty
       inspector.
     - **In-Fitting routing.** Garrison's router exposes a path
       prefix per Fitting; the Fitting handles its own sub-routes.
     - **Cross-tab linking.** A Fitting can emit URLs of the form
       `garrison://documents/<doc-id>` that resolve to its own
       views. Other parts of Garrison (chat, etc.) can link via
       these.
     - **Event bus** for Fitting → Operative talkback (deferred,
       Phase 7 still adds this; v2 only does views + routing +
       linking).
   - `AGENTS.md` §9 updated to spec the v2 contract.
   - `METADATA.md` updated for the new `x-garrison.ui` shape.
   - Migration path for existing Phase 1 Fittings (Slack, Memory):
     they keep their v1-style single-pane UIs. The contract v2 is
     additive — v1 declarations still work.

3. **Artifact Store Faculty (storage + browsing layer).**
   - New Faculty kind: `artifact-store`. Cardinality `single` per
     composition. Provides storage, retrieval, listing, and link
     generation for any file produced by the Operative or its
     Fittings.
   - Seed Fitting at `fittings/seed/artifact-store/`, shape
     `script` + UI extension.
   - **Storage model:**
     - Filesystem-backed. Default root:
       `<composition-dir>/artifacts/`. Configurable per Fitting.
     - Hierarchical namespaces: `artifacts/documents/`,
       `artifacts/automations/`, `artifacts/voice/`. Producer
       Fittings write into their own namespace.
     - Each artifact has metadata: producer Fitting id, mime type,
       created-at, optional title. Stored as a sidecar `.meta.json`
       or in a top-level index — pick at impl. Simple sidecar
       leans simpler.
   - **Tools exposed to consumers:** `write_artifact(namespace,
     filename, content, metadata)`, `read_artifact(id)`,
     `list_artifacts(namespace?, filter?)`,
     `link_artifact(id) -> garrison://artifacts/<id>`.
   - **UI surface:** sidebar-surface using contract v2.
     File-browser view with namespace tree on the left, file list
     on the right. Each file row: name, producer, type icon,
     created-at, size. Clicking a file opens the *appropriate
     viewer*:
     - For markdown: routes to the Documents Fitting's read view
       (`garrison://documents/<id>` resolves through Artifact Store
       metadata).
     - For video: routes to a built-in video player view (or the
       Automations Fitting's player view, when Phase 7 lands).
     - For audio: built-in audio player.
     - Otherwise: download link.
   - **`for_consumers` text:** generic — "to surface a file you've
     produced, write to your namespace via `write_artifact()` and
     emit a `garrison://artifacts/<id>` link in your chat reply.
     The user will be able to click through and view."

4. **Documents Fitting (layered on Artifact Store).**
   - New Fitting at `fittings/seed/documents/` under the
     `knowledge-base` Faculty.
   - `provides: { kind: knowledge-base, name: project-documents }`.
   - `consumes: { kind: artifact-store, cardinality: one }`.
     Documents does *not* implement its own storage — every
     document is an artifact in the `documents/` namespace of the
     Artifact Store.
   - **Documents adds on top:** the markdown editor view, the
     "evolve a document over time" semantics, and the PM/Architect
     hat discipline encoded in `for_consumers`.
   - Each document is a markdown file. Filename = artifact id +
     `.md`. Filesystem listing of the namespace is the document
     list.
   - Document `for_consumers` covers *intent*: PM hat triggers,
     conversation-converged signals, prefer-update-over-create,
     link-back conventions.

5. **Documents UI surface.**
   - Sidebar surface (uses contract v2's `sidebar-surface`
     placement).
   - Two views: read (rendered markdown), edit (editor).
     The *list* view of documents lives in the Artifact Store
     browser, filtered to the `documents/` namespace — Documents
     doesn't ship its own list view.
   - **Renderer:** `react-markdown`. Boring correct answer for
     read view.
   - **Editor:** lean toward `tiptap` + markdown extension (closer
     to claude.ai's artifact editing feel) over Monaco (too
     code-editor-flavored for prose). Confirm at implementation
     start.
   - Toggle button between read and edit. No live split-pane
     preview in v1 — explicit mode switch is enough.
   - URL shape: `garrison://documents/<doc-id>` (read),
     `garrison://documents/<doc-id>/edit`.
     `garrison://artifacts/<id>` for a markdown artifact resolves
     transparently to `garrison://documents/<id>`.

6. **Operative integration via `for_consumers`, not Orchestrator
   hardcoding.**
   - Both Artifact Store and Documents expose their tools via the
     existing capability mechanism. The Operative gets:
     `write_artifact / read_artifact / list_artifacts /
     link_artifact` (Artifact Store), and Documents-specific
     helpers if needed for editor-aware semantics
     (`update_document` may differ from `write_artifact` to
     preserve frontmatter / edit history; decide at impl).
   - **All "when to use Documents" guidance lives in the Documents
     Fitting's `for_consumers` block.** The Orchestrator stays
     generic.
   - **All "how to surface a produced file" guidance lives in the
     Artifact Store's `for_consumers` block.** Generic across
     producers.
   - This is the first real test of the locality principle: each
     Fitting teaches the Orchestrator how to use itself.

7. **Cross-linking from chat.**
   - When the Operative creates or updates a document, its chat
     reply should include the `garrison://documents/<doc-id>`
     link. When it produces any other artifact (in later phases:
     a video, an audio file), it emits
     `garrison://artifacts/<id>`. The Garrison chat renderer
     handles both URL schemes — clicking opens the appropriate
     surface.
   - This is the first real cross-Fitting link, and the test of
     whether contract v2's URL scheme works.

### Phase 3 done when

- I'm in a chat with the Operative about a feature. The
  conversation converges. The Operative says "I've captured this
  in a document — see garrison://documents/<id>." I click the
  link and land on the read view of the document.
- I click edit. tiptap (or chosen editor) loads the markdown.
  I edit, save, switch back to read view, see the rendered result.
- I open the Artifact Store browser (sidebar surface) and see the
  document I just created listed under the `documents/` namespace,
  with producer = Documents Fitting, mime = text/markdown.
- I drop a file directly into the artifacts directory on disk
  (e.g. a placeholder video). It appears in the Artifact Store
  browser with a generic "unknown producer" tag, openable via the
  built-in player. Proves the storage layer doesn't require a
  producer Fitting to exist.
- A second Fitting (created as a contract-v2 test) successfully
  ships two views with placement `faculty-tab` + `sidebar-surface`,
  proving the contract isn't Documents-shaped.
- A `garrison://artifacts/<id>` link for a markdown artifact
  resolves transparently to the Documents read view, proving the
  layered routing works.

### Open questions for Phase 3

- **Editor choice — tiptap vs `@uiw/react-md-editor` vs Monaco.**
  Lean tiptap; confirm at impl start by trying it against a real
  markdown sample and seeing the feel.
- **Artifact storage root** — `<composition-dir>/artifacts/` (lean)
  vs `~/Projects/garrison-artifacts/<composition-name>/` vs
  user-configurable. Owned by the Artifact Store Fitting's config,
  not Documents.
- **Artifact metadata format** — sidecar `.meta.json` per file
  (lean, simpler) vs central index file (faster listing, one more
  thing to keep consistent).
- **What to do when the Operative wants to update a document the
  user is currently editing.** Last-write-wins is the simplest;
  v1 doesn't need conflict resolution. Surface a notification in
  the editor if the file changed under it.
- **Project association** — when Phase 2's project index is in
  place, should documents (and artifacts more broadly) be scoped
  per-project? Probably yes eventually, but v1 = flat namespaces
  per composition. Add the per-project layer when project index
  is solid.
- **Cross-tab URL scheme — `garrison://` vs hash routing vs deep
  links via React Router.** `garrison://` reads cleanly in chat
  and is unambiguous. Confirm at impl whether it integrates
  cleanly with the existing Garrison frontend router.
- **`garrison://documents/<id>` vs `garrison://artifacts/<id>` for
  the same markdown artifact** — both should work, the former is
  the "open in editor" affordance, the latter is the "open in
  whatever default viewer" affordance. Document the convention.
- **Event bus for Fitting → Operative talkback** — deferred to
  Phase 7 with the rest of the original UI contract redesign.
  Documents/Artifact Store v1 don't need it; the editor saves a
  file, the Operative reads the file the next time it consults
  the Fitting.

### Out of scope for Phase 3 (deferred)

- Memory Fitting UI surface. Will be similar to Documents but
  separate, separate phase, separate Fitting. Tracked in parking
  lot.
- RAG over the document corpus. Useful, but additive, not
  required for v1.
- Multi-user editing / collaboration features.
- Document version history beyond what filesystem + git would
  give.
- Rich-media embedding *inside markdown* (images, diagrams).
  Markdown-only v1. Note: rich-media files as separate artifacts
  in the Artifact Store *are* in scope (you can save a PNG, view
  it in the artifact browser); embedding them inline in a doc is
  the deferred part.
- Per-project document scoping. v1 = flat per composition.
- Artifact retention/pruning policies. v1 = nothing is ever
  pruned. Phase 7+ when video artifacts make storage growth real.

---

## Phase 4 — Plan-then-execute on real projects — **DONE (2026-05-08)**

**Status:** Complete. Tickets T1–T7 from `PHASE_4_EXECUTION.md`
all landed. 134/135 tests pass, typecheck clean. Three
implementation observations worth recording:

1. **`Query.interrupt()` exists in the SDK** — direct
   first-class cancellation primitive. T6's kill switch uses
   this rather than process-tree termination. Cleaner than the
   plan anticipated.
2. **Variant A (CLI-shape) chosen for sub-agent spawning** — the
   coding-subagent Fitting looks like every other Garrison
   Fitting from the outside. Same `script` shape, same CLI
   surface, same `for_consumers` injection. Future Fittings that
   want sub-agent spawning have an idiomatic reference now.
3. **Setup hook auto-restores the SDK symlink** — `runner.ts:87-90`
   ensures `apm install` + `runSetupHooks` run on every Operative
   up, so the gateway's SDK install gets re-symlinked into
   `coding-subagent` automatically. No drift.

**Outcome:** I finish a discussion with the Operative, say "plan and
do it," and it: produces a plan via Claude Code's planning tool, asks
me to approve, then executes the work in the right project folder.

### Scope

1. **The session-spawning question — resolve it.**
   - **Option A:** Same gateway session does the work, switching its
     `cwd` to the project folder for the run. Simpler. But: pollutes
     the conversational context with code-edit chatter, and a long
     coding session eats the context window the conversational hat
     needs.
   - **Option B:** Spawn a *new* Claude Code session in the project
     folder for the work. Headless or visible. The gateway session
     dispatches a job to it, watches stdout, reports back.
   - **Option C:** Sub-agent invocation via the SDK in the same
     process — keeps the gateway session "in charge" but offloads the
     coding work into a child agent with its own context.
   - **Recommendation (to debate):** **Option B** is the EKOA-style
     answer (Vitruvius-shaped, multi-session), but it reopens the
     Orchestrator-shape decision the v1 spec deferred. **Option C** is
     the v1-aligned answer (single-session governing prompt + SDK
     sub-agent calls). Option C is probably the right v1 answer; B is
     the destination if the SDK's sub-agent invocation can't carry
     the file-system work cleanly.
2. **Planning tool integration.**
   - When the Orchestrator decides to plan, it invokes Claude Code's
     planning tool (skill or built-in?) and surfaces the plan to me
     in the chat (or Slack thread).
   - I approve / reject / edit. On approve → execution.
3. **Execution path.**
   - For Option C: SDK sub-agent invocation, working directory set
     to `projects_root/<project_name>`, full Claude Code feature set.
   - For Option B: spawn a fresh `claude` process in that directory
     with the same orchestrator+soul system prompt (or a coding-only
     variant of it), capture output back into the gateway log.
4. **Project-folder discovery.**
   - Phase 2 gives us the project index. Phase 4 uses it to *resolve*
     "the Garrison Workspace Faculty" → `projects_root/agent-garrison`.
   - Ambiguity prompts: if the user says "let's plan it" without
     project context, ask which project.
5. **Quick-task escape hatch.**
   - Not every task needs a project context or a planning step. The
     Orchestrator (via Classifier) routes tier-1/2 prompts through
     the same conversational gateway session — no spawn, no plan.
6. **Observability.**
   - The Run tab should show the spawned coding session as a separate
     log stream alongside the gateway log. (This is essentially what
     the Workspace Faculty wants in v1.1, but a minimal version is
     unavoidable in Phase 4.)

### Phase 4 done when

- "Let's plan the Garrison Slack channel Fitting and then do it" →
  Operative produces a plan referencing the right files in
  `projects_root/agent-garrison`, asks me to approve, then executes
  and reports back.
- Quick task ("rename this variable in file X") works without
  spawning anything.
- The conversational session's context isn't polluted by the coding
  session's chatter.

### Open questions for Phase 4

- **Option A vs B vs C: which?** This is the biggest open call.
  Likely C with B as fallback, but want to think through SDK
  sub-agent ergonomics first.
- **Observability of the spawned work — what do I want to see?**
  Just the chat-level result summary, a second log stream in the Run
  tab alongside the gateway log, or a full second "session" tab with
  its own chat+log view? **Deferred to Phase 4 itself** — the answer
  gates whether Phase 4 ends up adjacent to or partially inside the
  Workspace Faculty design. If it's option 3 (full session view),
  Phase 4 should be designed multi-session-aware from the start
  rather than retrofitted.
- **Planning tool:** is there a built-in Claude Code planning skill
  to invoke, or do we ship our own under the `skills` Faculty?
- **Approval UX:** plan rendered as markdown in chat, with
  approve/reject buttons in Slack? In the desktop UI?
- **What happens mid-execution if I want to redirect?** Inject a
  message into the coding session? Kill and restart? Workspace v1.1
  territory, but Phase 4 needs a v0 answer.

---

## Phase 5 — Workbench: a family of Faculties for tools — **DONE (2026-05-11)**

**Status (2026-05-11):** Shell + seeds + Sequoias parity all shipped.
4 Workbench Faculties (`terminal`, `screen-share`,
`worktree-management`, `session-view`) and 4 seed Fittings ship.
Phase 5.5 (port allocation engine, env rewriting,
`package.json` patching, Claude Code hook wiring) landed same-day
after an audit caught the original Phase 5 had stopped at the
shell. T8 (retire Sequoias) deferred only by the 3-day daily-use
gate.

**Outcome:** Garrison gains a "Workbench" area in the shell — a family
of Faculties (each with stable contracts) hosting Fittings that
provide non-agentic tools the user works with directly. The phase
delivers a seed set of Workbench Faculties (`worktree-management`,
`session-view`, `terminal`, `screen-share`) and the Fittings that
fill them.

The verification milestone for the phase is the **Sequoias
decomposition**: replacing the standalone Sequoias worktree-manager
app with three Workbench Fittings (`worktree-management`,
`session-view`, `terminal`). Once Sequoias can be retired in favor
of the Workbench composition, the pattern is proven.

**Naming note:** Early planning used "Armory" for both the Fitting
registry browser (`/armory`) and the tool area. The 2026-05-11
implementation resolved the collision: the tool area is **Workbench**
(`/workbench`); the Fitting registry browser stays **Armory**
(`/armory`). The `family: "workbench"` field on FacultyDefinition
identifies Workbench Faculties.

### Why this phase exists, and where it sits

- Phase 4 made the Operative competent at *delegating* coding work
  (plan + spawn). Phase 5 gives the user a tooling surface that
  lives alongside the Operative — terminals, worktrees, session
  monitoring, screen share — composable through the same Faculty/
  Fitting machinery as everything else.
- **Critical platform reframe (revised 2026-05-08):** earlier
  versions of Phase 5 specced a separate "Trenches" tab as
  Garrison-core. That was a category error — the platform thesis
  is "Faculties + Fittings compose; Garrison's shell renders what's
  installed." The moment we built a separate area, we'd be saying
  "but actually some things don't follow the rules." Workbench keeps
  the rules: tools are just Fittings under a family of Faculties.
- The first user is technical and the seed Faculties reflect that
  bias (terminals, worktrees). The architecture is open: users can
  declare ad-hoc Workbench Faculties in their composition for one-off
  needs, and over time other tool categories (non-development) can
  ship as Workbench Faculties without architectural change.

### Naming

- **Workbench** — the shell area that groups Faculties whose Fittings
  provide tools. "Where the gear lives," pairs naturally with
  Operatives, single-word noun, fits the Garrison metaphor.
- **Workbench Faculty** — a Faculty whose Fittings render in the
  Workbench area of the shell. The current seed set:
  `worktree-management`, `session-view`, `terminal`,
  `screen-share`, `browser`.

### Scope

1. **Workbench section in the Garrison shell.**
   - The shell reads the active composition's `x-garrison` block,
     identifies all installed Fittings whose declared Faculty is
     an Workbench Faculty, and renders each in the Workbench area.
   - **No special-cased UI.** The Workbench uses the same UI Fitting
     mechanism as the existing chat surface and Phase 3's
     contract-v2 sidebar surfaces. If APM's existing UI Fitting
     support doesn't cover what the Workbench needs, the gap is in
     the broader UI Fitting mechanism — fix benefits both.
   - Layout: left rail showing installed Workbench Fittings as
     entries, main pane rendering the active Fitting's view.
     Multiple Fittings can be open at once (split / tabbed —
     decide during T0 analysis).

2. **Seed Workbench Faculties (well-known with stable contracts):**
   - `worktree-management` — manages git worktrees: list, create
     with port allocation and startup commands, delete.
   - `session-view` — surfaces session state across the rest of
     the Workbench: which terminals are running, which worktrees are
     idle/busy, status indicators.
   - `terminal` — embedded terminal (xterm.js + PTY backend).
     Multi-session, busy/idle indicators, host selector.
   - `screen-share` — capture-and-relay of the user's primary
     display. Watch from a phone or another machine.
   - `browser` — embedded browser surface for web tools the user
     wants alongside their other Workbench tools (Excel-for-web,
     dashboards, etc.). Lower priority for v1 — see T-list.

3. **Action contract for Workbench Fittings.**
   - Workbench Fittings that expose actions (create worktree, kill
     session, launch shell at path) declare them via the existing
     `provides`/`consumes` contract — same wiring as Operatives.
   - **Operative bridge is design-now-cost-zero.** An agent-skill
     Operative can invoke Workbench tool actions via the same wiring
     graph. v1 doesn't ship a working bridge; the contract just
     accommodates it without rework.

4. **Sequoias decomposition (verification target).**
   - Three Fittings, each filling one Workbench Faculty:
     - `worktree-management:sequoias` Fitting — provides the
       current worktree set; exposes create-worktree action.
     - `session-view:sequoias` Fitting — consumes worktree stream;
       provides session state (running, idle, needs attention,
       finished); exposes actions (open PR, kill session, refocus).
     - `terminal:armory-default` Fitting — consumes the active
       worktree selection; renders xterm-based terminal in that
       directory.
   - Once these three Fittings work in Garrison, Sequoias the
     standalone app is retired.

5. **Quick-launch as actions on the `terminal` Fitting.**
   - "Open Orchestrator" and "Open Claude Code" are *not* a
     separate Fitting; they're launch presets the `terminal`
     Fitting exposes as actions.
   - Open Orchestrator: spawns a terminal with `claude
     --append-system-prompt <assembled-prompt>` in Garrison's
     working directory. Disabled when a remote host is selected.
   - Open Claude Code: spawns a terminal with plain `claude`
     command and configurable default flags at a chosen path.

6. **Multi-host via Tailscale + SSH.**
   - User-managed host list at `~/.garrison/hosts.json` (per-user
     global, *not* per-composition — hosts follow the human, not
     the Operative).
   - Host selector on `terminal` Fittings (and any other Workbench
     Fitting that wants it). Local is implicit and always
     available.
   - Remote launches wrap commands in `ssh -t <user>@<address>
     '<command>'`. Trusts user's SSH config.
   - Operative-aware actions (Open Orchestrator) are local-only;
     disabled when a remote host is selected.

7. **Ad-hoc Workbench Faculties (extensibility).**
   - Users declare ad-hoc Workbench Faculties in their composition's
     `x-garrison` block when they need something one-off (a custom
     dashboard, a specialized tool).
   - Ad-hoc faculties don't get the well-known-contract guarantees
     — they wire and render, but other Fittings can't depend on
     contracts that aren't published.
   - This is the extensibility seam that lets the Workbench grow
     beyond the seed set without core changes.

### Deferred (acknowledged, not done in Phase 5)

- **Operative bridge (working, end-to-end).** Action contract
  designed for it; v1 doesn't ship the bridge invocation path.
  Phase 7 or later.
- **Persistent sessions across Garrison restarts.** v1 sessions
  die on restart. Phase 7+ if needed.
- **Server-side file-explorer dialog** for path picking. Free-text
  path is fine for v1.
- **Auth/security around remote hosts beyond SSH key auth.** v1
  trusts Tailscale + SSH config.
- **Cross-platform screen share.** v1 is macOS-first per Sequoias/
  Harmonika prior art.
- **Public discovery / curated lists / marketplace for Workbench
  Fittings.** Downstream concern; Garrison must first be useful
  for a single user.
- **Multi-domain Workbench Faculties** (marketing, finance, ops,
  etc.). Belong to Ekoa for now. Workbench is scoped to the
  agentic-development workflow.

### Phase 5 done when

- I open Garrison, the Workbench area shows four Fittings
  (`worktree-management-sequoias`, `session-view-sequoias`,
  `terminal-armory-default`, `screen-share-default`) under the
  active composition. **[Done 2026-05-11]**
- I create a worktree from the worktree-management Fitting;
  it appears in session-view, and clicking on it opens a
  terminal in that worktree's directory. **[Done — Phase 5.5
  wires `createWorktree` to allocate ports, copy + rewrite env
  files, patch frontend dev scripts, and upsert a Session row
  visible to session-view.]**
- I open three terminals as separate sessions, run things in each
  independently, see at a glance which is busy via session-view.
  **[Done — Phase 5.5 installs Claude Code hooks that POST to
  Garrison's hook endpoint, driving working/waiting/idle/dead
  badges from real session activity.]**
- I SSH-launch a terminal on another Tailscale host from the
  terminal Fitting's host selector. **[Done — Trenches SSH re-homed]**
- I open the Garrison UI on my phone and watch the screen-share
  Fitting show what's happening on my desktop. **[Wired; macOS
  Screen Recording permission required — see PHASE5_VERIFICATION.md §4]**
- Sequoias the standalone app is retired in favor of the Workbench
  composition. **[Deferred — 3-day daily-use gate not yet met; T8.
  Phase 5.5 closed the parity blocker.]**

### Phase 5.5 — Sequoias parity port (closed 2026-05-11)

A 2026-05-11 audit caught that the original Phase 5 had shipped the
Workbench shell + four Fittings + state-file *reader* but not the
engine pieces that make Sequoias load-bearing. Phase 5.5 ported the
missing pieces the same day:

1. **Deterministic port allocation — shipped.** `src/lib/worktree/ports.ts`
   exposes `allocatePort(branch, service)` (FNV-1a → 50000–54999 with
   linear probe + wrap). Called from `createWorktree`.
2. **Env-file rewriting and `package.json` patching — shipped.**
   `src/lib/worktree/env-rewriter.ts` does the full Sequoias env
   pipeline (discoverEnvFiles → readMainPortMap → rewriteEnvFiles →
   ensureWorkspacePortFiles). `src/lib/worktree/package-json-patcher.ts`
   ports `patchFrontendDevScripts`; marker renamed to
   `GARRISON_FRONTEND_PORT`.
3. **Claude Code hook wiring — shipped.** `src/lib/claude-hooks.ts`
   merges 4 hook groups (UserPromptSubmit/Stop/Notification/
   PostToolUse) into `~/.claude/settings.json` non-destructively,
   marked `_garrison: true`. Snapshot lives at
   `~/.garrison/hooks-snapshot.bytes`. Hook URL is derived at install
   time from the running Garrison's request origin (via
   `POST /api/workbench/sessions/install-hooks`). The receiver at
   `/api/workbench/sessions/hook` calls `findSessionByCwd` and
   `setSessionStatus` to update `~/.garrison/sessions/state.json`.
   The session-view reader merges `~/.garrison/sessions/state.json`
   with `~/.sequoias/state.json` during the migration window.
4. **State-path drift — partially addressed.** Session state moved
   to Garrison-owned `~/.garrison/sessions/state.json`. Worktree
   directories stay at `~/.worktrees/<repo>/<slug>` (intentional —
   matches Sequoias so the two tools coexist while T8 plays out).

**Live status pipeline:**

```
Claude Code in /wt/<branch>
  → settings.json hook fires curl POST {event, cwd}
  → POST /api/workbench/sessions/hook
  → findSessionByCwd(cwd) → {projectPath, branch}
  → setSessionStatus(...) writes ~/.garrison/sessions/state.json
  → SessionView next 5s poll re-renders
```

**Tests landed:** `tests/worktree-ports.test.ts` (port determinism,
allocator probe/wrap), `tests/worktree-env-rewriter.test.ts`
(discover/parse/rewrite/inject), `tests/claude-hooks.test.ts`
(install/restore/idempotency), `tests/garrison-sessions.test.ts`
(store CRUD + cwd lookup + merge fallback).

**Blocker on T8 removed.** Sequoias retirement is now only gated on
3 consecutive days of daily-use validation.

### Open questions for Phase 5

- **Analysis session at phase start (T0)** — pre-agreed. Walk the
  Sequoias and Harmonika code, confirm exact files/components to
  lift, settle the Workbench shell layout, settle the
  screenshot-vs-streaming choice for screen-share, settle terminal
  busy-detection heuristic.
- **Default Claude Code flags** — `--dangerously-skip-permissions`
  is implied; settle the rest at T0.
- **Layout in the Workbench pane** — single-fitting-active vs
  tabbed-multi-fitting vs split-grid. Decide at T0 based on what
  Sequoias decomposition makes natural.
- **Browser Faculty scope for v1** — full Fitting or deferred?
  Lower priority than terminal/worktree/session/screen-share;
  likely deferred. Confirm at T0.
- **APM UI Fitting parity** — does the existing UI Fitting
  mechanism cover what Workbench needs (action declarations,
  provides/consumes wiring through to UI)? Gap-find at T0;
  if there's a hole, fix it as Garrison-core work that lives
  outside the Workbench but unblocks it.

---

## Phase 6 — Outposts: multi-machine reach via a local bridge

**Outcome:** Garrison gains an `outposts` Faculty. Each Outpost
Fitting represents one remote Mac (or other host) running a small
**bridge** process. From a single Operative on the host machine,
Garrison can spawn worktrees, run terminals, execute commands,
watch files, and (over time) carry the full Operative action
surface across N machines connected via Tailscale.

The phase is the foundation for "I sit at any Mac; my Garrison
runs on the always-on Mac; everything I do feels local."

### Why this phase, why now

The user runs three Macs on Tailscale: the **automation machine**
(Mac Mini M4, 16 GB, always on — hosts Garrison + Operative), the
**development machine** (MacBook Pro M1 Max, 32 GB, always on —
primary code work), and the **portable machine** (MacBook Air M4,
16 GB, intermittent uptime — carried around).

Today Garrison is single-machine: one Operative on one host, with
everything (Trello, Calendar, Slack, Memory, Documents, Artifacts,
Workbench) bound to that machine's filesystem and processes. To
use Garrison from a second Mac, the user has to either
remote-desktop into the first Mac or run a second Garrison
instance — neither composes with the single-Operative model.

Phase 5 (Workbench) shipped Sequoias-decomposed Fittings that
handle worktrees + sessions + terminals locally. Sequoias-the-app
*already* supports multi-machine via a similar bridge pattern; the
Workbench port lost that capability. Phase 6 restores it as a
proper Faculty rather than a Sequoias-specific feature.

This is also the phase that begins to repay the architectural
investment: the bridge is generic — Operative actions, vault sync,
filesystem operations, command execution — all reuse it. Phase 7
Automations and Phase 8 Tasks will both benefit.

### The bridge architecture

**Host machine** (automation machine) runs Garrison + the
Operative as today.

**Each remote Mac** runs a small `garrison-outpost-bridge` process
that:

- Authenticates to the host (Tailscale already provides network
  trust; the bridge adds a Garrison-issued token for identity).
- Holds a persistent WebSocket connection to the host.
- Exposes RPC-like operations: spawn-process, watch-file,
  list-files, list-worktrees, run-command, etc.
- Streams events back to the host: process output, file changes,
  process exit, status changes.
- Sleeps when idle (no resource cost beyond the socket).

**The host's Outposts Faculty:**

- `provides: { kind: outpost, cardinality: many }` — one Fitting
  per remote Mac.
- Each Fitting maintains the WebSocket connection to its bridge.
- Exposes uniform RPC + event subscription as a capability that
  other Fittings (Workbench's worktree-management, terminal,
  session-view, etc.) consume.

**The transport:** WebSocket over Tailscale (no public exposure;
Tailscale handles routing and encryption). Message framing: JSON
for v1 (simple, debuggable). Switch to msgpack or protobuf only
if the wire overhead bites — unlikely for the message volumes
this phase deals with.

**Why not SSH:** SSH alone handles fire-and-forget commands but
doesn't carry long-lived state, bidirectional streams, filesystem
watching, or reverse calls cleanly. Building those on top of SSH
means reinventing framing per feature; the bridge does it once.

### What the bridge does NOT do

- **Run an Operative.** v1 keeps one Operative on one host
  machine. The bridge gives the Operative *hands* on other
  machines, not *brains*. Splitting the Operative across machines
  is explicitly out of scope.
- **Hold its own memory or state.** The bridge is dumb;
  orchestration logic lives on the host.
- **Cache or persist anything meaningful.** Restart safety = host
  reconnects, bridge re-presents current machine state.

### Scope

1. **`outposts` Faculty + bridge protocol.**
   - New Faculty kind: `outpost`, cardinality `many` per
     composition.
   - **Protocol** documented in `PHASE_6_PROTOCOL.md`:
     - WebSocket over Tailscale.
     - JSON message framing with typed `{version, type, id, payload}` shape.
     - Bidirectional: host sends RPC requests, bridge sends
       responses + unsolicited events.
     - Operations grouped into namespaces: `process.*`, `fs.*`,
       `git.*`, `exec.*`.
     - Versioned at connect time; mismatches fail loudly.
   - **Auth:** host issues a token per outpost. Bridge presents
     it on connect. Token rotation: manual reissue + bridge
     restart for v1. Stored on the bridge side in
     `~/.garrison-outpost/config.json`.

2. **`garrison-outpost-bridge` (the remote-side process).**
   - New repo / package: `garrison-outpost-bridge` (its own
     GitHub repo, like memory-compiler). Cloned by setup to
     `~/.garrison-outpost/` on each remote Mac.
   - Stdlib-leaning Node 20+ (matching Garrison's other Node
     pieces). One persistent connection, one process.
   - Manifest + version, so the host can detect protocol-version
     mismatches and refuse to connect cleanly.
   - launchd plist installed to keep it running across reboots
     (macOS-first; user uses the bridge on Macs only for v1).
   - Logs to `~/.garrison-outpost/logs/` with daily rotation.

3. **`outpost:tailscale-host` Fitting (host side).**
   - Seed Fitting at `fittings/seed/outpost-tailscale-host/`.
   - Configured with: machine name, Tailscale address, optional
     SSH user (for the *bootstrap* — see T-ticket later).
   - `provides: { kind: outpost, name: <machine-name> }`.
   - Holds the WebSocket connection. Reconnects automatically
     with exponential backoff on disconnect.
   - Exposes the protocol operations as a uniform capability
     surface other Fittings consume.

4. **Bootstrap: getting the bridge onto a remote Mac.**
   - First-run setup on each remote Mac:
     - Host generates a token + invitation script.
     - User runs the script on the remote Mac (SCP'd from host
       or curl-pipe-bash for v2).
     - Script clones `garrison-outpost-bridge`, installs deps,
       writes token, installs the launchd plist, starts the
       daemon.
     - Host sees the bridge connect, displays it in the Outposts
       Faculty's UI as "connected — `development`".
   - SSH used *only* for the bootstrap. Once the bridge is up,
     all subsequent traffic is via WebSocket through the bridge.

5. **Workbench integration (the headline use case).**
   - The Workbench Fittings from Phase 5 grow an "outpost selector":
     - `worktree-management:sequoias` — when an Outpost is
       selected, worktrees are managed on that machine via the
       bridge's `git.*` operations.
     - `terminal:armory-default` — when an Outpost is selected,
       PTY is spawned via the bridge's `process.spawn` and
       streamed back through `process.io` events.
     - `session-view:sequoias` — status data flows from the
       remote machine's processes via bridge events.
   - **The user experience:** I'm on the development machine,
     open Garrison's web UI pointing at the automation machine,
     click "New Worktree" with Outpost = development selected.
     The worktree is created on the development machine's disk.
     The terminal opens on the development machine. I see all of
     it through the automation machine's Garrison UI.
   - This is the deliverable that makes the phase real for the
     user's workflow.

6. **Operative-side bridge usage.**
   - The Operative gains access to bridge operations through a
     new agent-skill Fitting (`outpost-actions` or similar) that
     exposes:
     - `run_on(machine, command)` — execute a command on a
       remote Mac.
     - `read_file_on(machine, path)`, `write_file_on(...)`,
       `list_files_on(...)`.
     - `spawn_on(machine, command)` — start a long-running
       process and get streaming output.
   - This is the design-now-cost-zero part: the bridge already
     supports these operations because the Workbench needs them;
     wiring them to an Operative-callable skill is a small
     additional Fitting.
   - **For consumers (Operative):** when does it use this? The
     `for_consumers` text guides — "when the user mentions a
     machine by name, or when a task is naturally local to a
     specific machine, route through outpost-actions; otherwise,
     act locally."

7. **Vault sync as the first bridge-driven service.**
   - The user's Obsidian vault (`~/Projects/ekus/obsidian-vault/`)
     today lives on the host machine. Git syncs it to a remote,
     but the remotes get out of date.
   - New seed Fitting: `vault-sync` (Faculty TBD — likely a new
     `sync` Faculty, since this isn't really an automation).
   - `consumes: outpost:many` (one per machine that wants the
     vault).
   - Periodically (or on file-change events from the bridge's
     `fs.watch`) mirrors the host's vault directory to each
     selected outpost.
   - Bidirectional in v1 is hard; **start unidirectional**
     (host → outposts). The host machine is the authority. Edits
     on remotes are pushed back through git as today (manual
     flow). Full bidirectional sync deferred to a later phase.

### Phase 6 done when

- I run the bootstrap script (or whatever the one-liner is) on
  the development machine. Within a minute, that Mac appears in
  the host's Outposts Faculty as connected.
- I create a worktree on the Mac I'm sitting at, even though
  Garrison is running on the automation machine. The worktree
  appears on the correct machine's filesystem.
- I open a terminal in an Outpost-managed worktree from
  Garrison's web UI. Commands run on the remote machine. Output
  streams back live.
- I ask the Operative "run `ls ~/Projects` on development" — it
  invokes `outpost-actions` and returns the result.
- The vault on the development machine stays in sync with the
  automation machine's vault within a few seconds of changes
  (host → remote direction).
- Bridge reconnects cleanly after the portable machine sleeps
  and wakes.

### Open questions for Phase 6

- **Protocol choice for v1: JSON over WebSocket (lean) vs gRPC
  vs custom binary.** JSON is debuggable and good enough for the
  message volumes Phase 6 generates. Revisit if profiling shows
  framing overhead matters.
- **Auth model details.** Token-on-handshake is the v1 plan.
  Whether to add per-operation signing, rotation policy, or
  short-lived refresh tokens is open. v1 = static token,
  manual rotation.
- **Bridge update mechanism.** When the protocol version on the
  host bumps, how do remote bridges learn and update? v1 =
  manual ("user re-runs the bootstrap"); v2 could include a
  self-update path.
- **Filesystem semantics across machines.** Path conventions:
  do `read_file_on("development", "~/Projects/x")` and
  `read_file_on("host", "~/Projects/x")` resolve sensibly when
  home dirs differ? v1 expects callers to use absolute paths
  most of the time; tilde expansion happens on the remote side.
- **Connection multiplexing.** Multiple Fittings consuming the
  same outpost — do they share one WebSocket or open separate
  ones? Sharing is more efficient; concurrent operation safety
  is the cost. Lean: share, with operation IDs for response
  routing.
- **Failure modes.** What does the UI show when an outpost
  disconnects mid-operation? Worktree creation fails? Terminal
  hangs? Need explicit error surfacing per operation type.
- **Host-side WebSocket server location.** The HTTP gateway is
  the natural home (long-lived, already handling other
  connections), but it currently does HTTP only. Adding a
  WebSocket route is small; confirm the gateway can host both
  cleanly during T0/T2.

### Phase 6 ticket status

- **T0 — Protocol spec.** **Done (2026-05-11).** `docs/phases/PHASE_6_PROTOCOL.md` committed (41cbbdd).
- **T1 — `garrison-outpost-bridge` daemon.** **Done (2026-05-11).** Standalone repo at `github.com/gongiskhan/garrison-outpost-bridge`. All 24 protocol operations implemented. 10/10 smoke test. Initial commit 2be13cb.
- **T2 — Host-side Fitting + WS endpoint.** **Done (2026-05-11).** `scripts/outpost-host.mjs` (port 3702, 0.0.0.0), `outposts` Faculty (19th, `family: "workbench"`, `cardinality: "multi"`), `outpost` capability kind, `fittings/seed/outpost-tailscale-host/`, `src/app/api/workbench/outposts/` routes, `OutpostView.tsx` (3s polling). Registry at `~/.garrison/outpost-registry.json`. All tests pass; typecheck clean.
- **T3 — Bootstrap script.** **Done (2026-05-11).** `scripts/bootstrap-outpost.sh` (curl-pipe-bash, node≥20 + git check, Tailscale warn, clone/pull bridge, npm install + build, writes config.json, sed-fills launchd plist, bootstraps with launchctl, polls log for `[connection] ready` up to 60s). `src/app/api/workbench/outposts/bootstrap-outpost/route.ts` serves the script as text/plain. `src/app/api/workbench/outposts/generate/route.ts` generates 32-byte token, registers with outpost-host, returns one-liner command. `OutpostView.tsx` updated with "Generate bootstrap command" wizard (machine name + Garrison host → command display with Copy button). All tests pass; typecheck clean.
- **T4 — Terminal with outpost selector.** **Done (2026-05-11).** `TrenchesPanel.tsx` outpost `<optgroup>` dropdown (`local` / `ssh:<name>` / `outpost:<name>`); 3s polling of `/api/workbench/outposts`; spawns PTY via `callRpc process.spawn` routed through `outpost-host.mjs`.
- **T5 — Worktrees multi-project + multi-machine.** **Done (2026-05-11).** `WorktreeView.tsx` rebuilt with machine selector + project selector (lists all dirs under dev folder of the selected target). Prefs store at `~/.garrison/workbench-prefs.json` via `src/lib/workbench-prefs.ts`; `PATCH /api/workbench/prefs` persists last-selected machine and project per machine. `/api/workbench/projects` lists directories locally (`fsp.readdir`) or via `fs.list` RPC for outposts. `/api/workbench/worktrees` accepts `?target=local|outpost:<name>` and routes to local lib or bridge `git.*` RPCs. Fitting metadata updated: `consumes outpost`, `repo_path` now optional (first-launch seed). Fitting validation PASS.
- **T6–T8.** Not started.

### Out of scope for Phase 6 (deferred)

- **Multi-Operative.** Still one Operative on the host. No
  Operative shards on remote machines.
- **Cross-platform bridges.** macOS only for v1. Linux/Windows
  later if the platform thesis pulls beyond Macs.
- **Bidirectional vault sync.** Host → outposts only. Two-way
  merge is hard; defer until there's a clear pattern.
- **Bridge auto-discovery.** Manual bootstrap per remote Mac.
  `tailscale status` parsing for auto-suggest is a nice future
  feature, not v1.
- **Resource limits on remote operations.** No "this bridge
  caps at N concurrent processes" — first user pain triggers
  the limit work.
- **Cross-outpost operations.** v1 = host orchestrates each
  outpost independently. "Copy file from outpost A to outpost B
  directly" routes through the host. Direct bridge-to-bridge is
  later.
- **Ekoa parity.** Garrison's bridge intentionally diverges
  where it makes sense. Convergence with Ekoa's similar work
  is a separate effort.

---

## Phase 7 — Automations Faculty as a real EKOA port

**Outcome:** Garrison has an Automations Fitting that does what
EKOA's automations system does today — Playwright-based browser
automation with a UI to author, run, fix, and replay them — wired
into Memory and the Orchestrator.

### Scope

1. **Port the EKOA automations system.**
   - Whatever EKOA uses (Playwright API or Playwright CLI — needs
     verification on the EKOA side; the user's recollection is "we
     used Playwright API but I'm not 100% sure"). Port that, don't
     reinvent.
   - Lives under `fittings/seed/automations-runner` or replaces the
     current `browser-automation` seed.
2. **UI surface — this is the first real test of UI surfaces beyond
   v1's "UI extension in the Faculty tab" model.**
   - Today, `x-garrison.ui.extension` lets a Fitting ship a React
     component that renders inside its Faculty's tab. That's the
     surface this Fitting will use.
   - The Automations UI needs: list of automations, run button,
     replay, edit selectors, see screenshots, mark a step as broken,
     give feedback that the agent can act on.
   - Re-evaluate whether the existing UI extension model is rich
     enough or whether Phase 7 needs a more general "Fitting UI"
     concept (probably the latter — see "UI surfaces" below).
3. **Memory integration.**
   - Automations remember their last successful run, common failure
     modes, and selector evolution. This is *automation-specific
     memory*, not user-memory — but it shares the Memory Faculty.
   - Either the Memory Faculty grows a "namespace" concept, or the
     Automations Fitting writes its own scoped memory file that the
     compiler picks up.
4. **Orchestrator awareness.**
   - The Orchestrator knows automations exist and can invoke them
     when appropriate (tier-2 task: "log into X and grab Y").
   - The Classifier may need a new tier behavior: "this looks like
     an automation, route to the automation runner."

### Phase 7 done when

- I can author an automation in the Garrison UI (or import from
  EKOA), run it, see it fail, fix the broken step interactively, and
  the Operative learns from the fix.
- The Orchestrator can invoke automations as tools during
  conversation.

### Open questions for Phase 7

- **Engine choice (must resolve before any porting):** EKOA has two.
  `cortex/` uses Playwright API in-process (`browser-pool.ts`,
  shared chromium instance, lazy-launch). `automato/` uses raw CDP
  via `chrome-remote-interface`. Which one do we lift? Cortex is
  more ergonomic; automato is closer to the metal.
- **UI hosting:** still trusted React in-process per the v1 model, or
  does Phase 7 push us toward iframe-sandboxed UI (v1.1 concern in
  the original plan)?
- **Memory namespacing:** new Memory Faculty config, or per-Fitting
  scoped writes that the compiler aggregates?

---

## Phase 8 — Tasks Faculty (Kanban-as-control-plane)

**Outcome:** A first-party `tasks` Faculty that owns task management
end-to-end — file-system-backed, with a Kanban UI surface — replacing
the Trello dependency as the source of truth. By the end of this
phase, the Operative reads, writes, schedules, and acts on tasks
from its own task store. Trello becomes optional: a Trello-sync
Fitting can mirror tasks bidirectionally for users who want it,
but Trello is no longer required.

This phase is the foundation for autonomous workflows. The Kanban
board becomes the visible control plane: a task appears, the
Operative picks it up, the user sees it move through columns, the
user accepts or rejects the result. People run software projects
and entire businesses on this pattern; Garrison's contribution is
making it composable and self-hostable.

### Why this is a phase, not a Phase 1 carry-over

Phase 1's Trello integration treated Trello as the source of truth.
That worked for v1 but has obvious limits: vendor lock-in, no
control over schema, no ability to encode Garrison-specific
task metadata, and Trello's API rate limits become Garrison's
problem. Owning the task store makes Garrison genuinely standalone
and lets task semantics evolve with the rest of the platform.

The Kanban-as-control-plane vision also requires the Tasks Faculty
to be aware of *Operative actions* (heartbeat picks, scheduling,
plan approvals, automation runs), not just user-edited cards.
That's a deeper integration than Phase 1's Trello-data-source.

### Scope

1. **Tasks Faculty + seed Fitting.**
   - New Faculty kind: `tasks`. Cardinality `single`.
   - Seed Fitting at `fittings/seed/tasks/`, shape `script` + UI
     extension (uses contract v2 from Phase 3).
   - **Storage:** filesystem-backed, under
     `<composition-dir>/tasks/`. Each task is one markdown file
     with YAML frontmatter (id, status, created, updated, labels,
     assignee, due-date) + a body for description / discussion /
     subtasks. Markdown chosen for grep-ability and human-edit
     friendliness; alternatives (single JSON file, SQLite)
     rejected for the source-of-truth-on-disk principle.
   - Status enum: fixed at `backlog | todo | in_progress | done`
     for v1. Customizable in later phases when there's evidence
     it's needed.
   - **Tools exposed to consumers:** `list_tasks(filter?)`,
     `read_task(id)`, `create_task(...)`, `update_task(id, ...)`,
     `move_task(id, status)`, `delete_task(id)`,
     `add_comment(id, ...)`.
   - `for_consumers` (Phase 3 mechanism): explains when to create
     tasks, when to mark them done, conventions around Operative-
     created vs user-created tasks (a metadata flag), and the
     "user adds task → Operative picks it up" pattern.

2. **Kanban UI surface.**
   - Sidebar surface (contract v2 `sidebar-surface` placement).
   - Four columns: Backlog, To Do, In Progress, Done.
   - Cards: title, labels, due-date if any, "owned by Operative"
     vs "user-created" indicator, last-action timestamp.
   - Drag-and-drop between columns. Click for detail view (opens
     a panel with full markdown body, comments, action history).
   - Filter bar: by label, by owner, by date range.
   - Real-time updates: when the Operative moves a card, the UI
     reflects it within a few seconds. Polling is fine for v1; SSE
     or websockets later if needed.

3. **Operative integration: tasks as control plane.**
   - **Manual task creation from chat:** the user says "remind me
     to call the bank tomorrow," the Operative creates a task in
     `todo` with a due-date. Discoverable via `for_consumers`,
     not Orchestrator hardcoding.
   - **Heartbeat-driven pickup (depends on Phase 2's heartbeat):**
     on its tick, the Operative reads tasks in `todo`, picks one
     that matches autonomy-allowed criteria (tier-1/2, has clear
     completion signal, no human-in-the-loop required), moves it
     to `in_progress`, and works on it.
   - **Plan-before-execute integration (depends on Phase 4):**
     for tasks the Operative judges higher-tier, it produces a
     plan via Phase 4's planning tool, asks the user to approve
     via Slack/chat, then moves the task forward only on approval.
   - **Automation integration (depends on Phase 7):** a task
     marked "needs browser automation" can be linked to a saved
     automation; running the automation ticks the task.
   - **Action history per task:** the task body grows over time
     as the Operative appends comments documenting what it did,
     what it checked, what it produced (links to artifacts via
     Phase 3's `garrison://artifacts/<id>`).

4. **Trello-sync Fitting (optional, replaces direct integration).**
   - New Fitting at `fittings/seed/trello-sync/`. Faculty:
     `data-sources` (or its own kind — see open question).
   - `consumes: { kind: tasks, cardinality: one }`. Reads the
     local Tasks store; mirrors selected lists to/from a Trello
     board.
   - Bidirectional, configurable per-list. Defaults: "A Fazer"
     ↔ `todo`, "Brevemente" ↔ `backlog`, "Doing" ↔ `in_progress`,
     "Done" ↔ `done`.
   - **Phase 1's `trello-data-source` Fitting becomes deprecated**
     by this. Migration path: ship both for one phase, drop
     `trello-data-source` after Phase 8 ships and users have
     migrated.

### Phase 8 done when

- I can create a task in chat ("remind me to do X"). It appears
  in the Kanban board's `todo` column within seconds.
- I can drag a task from `todo` to `in_progress` and the
  Operative knows about it.
- The heartbeat picks up an autonomy-allowed task, moves it to
  `in_progress`, completes it, moves it to `done`, and posts a
  summary as a comment on the task with a link to any artifacts
  produced.
- For a higher-tier task, the heartbeat produces a plan, posts
  it to the user via Slack, waits for approval, then proceeds.
- The Trello-sync Fitting (when installed) mirrors my Trello
  board into the local Tasks store and propagates local changes
  back to Trello.

### Open questions for Phase 8

- **Trello-sync Faculty:** new kind (`data-sync`?) vs reuse
  `data-sources` vs reuse `automation-runner`. Likely a new kind
  if other bidirectional syncs (Linear, Jira, GitHub Issues)
  follow the same pattern.
- **Tier semantics for autonomous pickup.** The Classifier already
  exists from Phase 1 with tier 1–N. Need a clear "autonomy floor"
  config — tier ≤ N runs autonomously, tier > N requires plan-then-
  approve. Per-user, possibly per-task-label override.
- **Customizable column sets.** v1 = fixed four columns. Probably
  enough for a long time. When customization arrives, it's per-
  composition config, not per-task.
- **Multiple boards / projects.** v1 = one board per Operative.
  When Phase 2's project index is solid, it might make sense to
  scope tasks per-project — but that interacts with how the
  Operative routes work between projects. Defer.
- **Real-time push to UI.** Polling for v1. SSE/websocket if
  polling load becomes real.
- **Conflict resolution with Trello-sync.** Two-way sync always
  has edge cases. Last-write-wins by `updated` timestamp for v1;
  surface conflicts to the user when they're unresolvable.

### Out of scope for Phase 8 (deferred)

- Multi-user / multi-Operative shared boards.
- Automation-style "run this task on a button click" — separate
  from Operative-driven task pickup. Considered for a later phase.
- Marketplace for task-board templates.
- Dependency graphs / blocked-by / sub-tasks beyond what markdown
  body conventions allow.
- Time tracking, burndown charts, sprint mechanics. Garrison
  isn't a Jira; staying out of project-management complexity.

---

## Cross-cutting: UI surfaces

**Decided 2026-05-05, revised 2026-05-06:** UI extension contract
evolves in two steps.

- **Contract v1** (current, per `AGENTS.md` §9): Fittings ship
  `x-garrison.ui.extension` pointing at a React component. Garrison
  lazy-imports it and mounts it in the Faculty's tab. Static render,
  no sandbox, trusted-author model.
- **Contract v2** (Phase 3 — Documents Fitting forces it):
  multi-view Fittings, placement (`faculty-tab` vs.
  `sidebar-surface`), in-Fitting routing, cross-tab linking via
  `garrison://<fitting>/<view>` URLs. Phase 1 v1-style Fittings
  keep working unchanged (additive contract).
- **Contract v3** (Phase 7 — Automations forces it): adds the event
  bus for Fitting → Operative talkback (e.g. "this selector is
  wrong, use this instead"). Stateful UI feedback loops.

**Phase 5 (Workbench) uses contract v2 fully.** Workbench Fittings ship
their UIs as multi-view contract-v2 declarations — same mechanism
Documents and the Artifact Store browser already use. The Workbench
shell area renders Fittings dynamically based on their declared
faculty (one of `worktree-management`, `session-view`, `terminal`,
`screen-share`, `browser`, or ad-hoc). This is the architectural
reframe from earlier Phase 5 versions ("Trenches as a separate
Garrison-core area"), captured in the 2026-05-08 decision log
entry.

**Phase 1 Fittings (Slack, Memory) ship with constrained v1
single-pane UIs.** They keep working under v2 unchanged. They get
retrofitted *opportunistically* — when one of them needs a richer
UI it migrates to v2. Phase 7's contract v3 work doesn't break v2
either.

**v2 contract shape (driven by Documents):**

- Fittings declare N views in `x-garrison.ui` (was
  `x-garrison.ui.extension`, the single field).
- Each view declares placement (`faculty-tab` | `sidebar-surface`)
  and a route fragment.
- Garrison's router exposes a per-Fitting path prefix; the Fitting
  handles its own sub-routes within it.
- `garrison://<fitting>/<view>` URLs resolve across the app — chat
  can link to Documents, Documents can link to other Fittings.

**v3 contract additions (Phase 7):**

- Event bus: Fitting views can dispatch structured events the
  Orchestrator listens on.
- Likely also: per-Fitting persistent state shared across views.
- Migrates Documents and any other v2 Fitting forward without
  breaking changes (event bus is opt-in).

This is closer to what the deferred Workspace Faculty wants for
panes in v1.1. Treat Phase 7's UI work as the *de facto* prototype
of Workspace.

### Retrofit consequences (acknowledged)

- Phase 1 Slack and Memory Fittings ship with v1 single-pane UIs.
  They keep working under v2 (additive contract). They migrate to
  v2 only when one of them needs richer UI than v1 can carry.
- Phase 3 Documents and any later Fittings ship as v2 from day
  one, then migrate to v3's event bus opportunistically when
  Phase 7 lands.
- The compounding retrofit cost (v1 → v3 in two hops) is accepted
  for the Phase 1 Fittings since their UIs are minimal and a
  one-time migration is cheap.

---

## Decision log (live)

Append-only. Each decision dated and short. Phase numbers
throughout reflect *current* numbering — when phases are renumbered,
older entries are updated to keep the numbering consistent across
the doc.

- **2026-05-06** — Phase 1 marked complete. Phases renumbered: the
  former Phase 2.5 (Documents + Artifact Store + UI v2) becomes
  Phase 3 to reflect that it's foundational and roughly Phase-1-
  sized. Subsequent phases shift up by one: old Phase 3 → 4 (plan-
  then-execute), old Phase 4 → 5 (Trenches), old Phase 5 → 6
  (Automations). New Phase 8 added: Tasks Faculty (Kanban-as-
  control-plane). Older decision-log entries updated to use the
  new numbers for readability.
- **2026-05-05** — Phased plan adopted: Phase 1 (PA-shaped seed),
  Phase 2 (real PA functionality), and what at the time were
  Phases 3–4 (plan-then-execute and Automations). Now: Phase 4
  and Phase 7 respectively, post-renumber.
- **2026-05-06** — Phase 5 added: **Trenches** (tooling surface
  for hands-on work — embedded terminal, screen sharing, Open
  Orchestrator/Open Claude Code launchers, multi-host via Tailscale +
  SSH). Lifts working code from Harmonika. Inserted between
  plan-then-execute and Automations.
- **2026-05-06** — Phase 3 added: **Documents Fitting** under
  the `knowledge-base` Faculty (claude.ai-style document workspace
  with markdown view + edit). Built as a Fitting, not Garrison-core,
  to keep the platform thesis (composable, optional). Brings the UI
  extension contract redesign forward from Phase 7 — Documents is
  the forcing function instead of Automations.
- **2026-05-06** — UI contract evolution split into three steps:
  v1 (today, single pane), v2 (Phase 3 — multi-view, placement,
  routing, cross-tab linking), v3 (Phase 7 — event bus for
  Operative talkback). v1 stays additive under v2/v3; v2 stays
  additive under v3. Phase 1 Fittings migrate opportunistically.
- **2026-05-06** — Documents Fitting scope explicitly excludes
  Memory Fitting integration. Memory gets its own UI surface in a
  later phase. Different lifecycle, different intent — keep separate.
- **2026-05-06** — Document title renamed: "Garrison Roadmap"
  (was "Garrison as Personal Assistant — Phased Plan"). The doc
  outgrew its name; it now covers all Garrison roadmap planning.
- **2026-05-06** — `for_consumers` field added in Phase 3.
  Provider-side usage instructions, concatenated into the
  Orchestrator's "tools available" block at assembly time.
  Locality principle: a Fitting that ships a capability also
  ships the doc on how to use it. Removes the need to hardcode
  Faculty-specific guidance in the Orchestrator. Phase 1
  Fittings retrofitted opportunistically. Spec changes to
  `METADATA.md`, `CAPABILITIES.md`, `AGENTS.md` §5.
- **2026-05-06** — Garrison-as-AI-composer: capture as future
  direction, build advisory/validation flavor (option a) only,
  don't build until a concrete need surfaces. Synthesis flavor
  (option b — LLM writes the assembled prompt) explicitly
  rejected for foreseeable future on reproducibility/cost/
  debuggability grounds.
- **2026-05-06** — Testing & Automations stay *separate* Faculties.
  Testing `consumes: { kind: automation-runner,
  cardinality: optional-one }`. Bash-style tests need no
  Automations; browser-flow tests use it. No duplication of
  infrastructure. Automations owns the reusable pieces:
  progressable steps, feedback loops, video recording, replay.
- **2026-05-06** — **Artifact Store Faculty added to Phase 3,
  layered under Documents.** Documents `consumes` Artifact Store;
  Documents owns *intent* (when/how to write a document),
  Artifact Store owns *substrate* (storage, browsing, links).
  Future Fittings (Automations videos, Voice audio fallback)
  reuse the same layer. Avoids merging four different intents
  into one Faculty's `for_consumers` block. Cross-tab links
  resolve through both `garrison://documents/<id>` and
  `garrison://artifacts/<id>`.
- **2026-05-06** — Phase 8 added: **Tasks Faculty
  (Kanban-as-control-plane).** First-party file-system-backed
  task store with a Kanban UI, replacing Trello as source of
  truth. Trello becomes optional via a Trello-sync Fitting that
  consumes the local Tasks store. Foundation for autonomous
  workflows — heartbeat picks up tasks, plan-then-execute on
  higher-tier ones, automation runs tick tasks. Phase 1's
  `trello-data-source` Fitting deprecated by Phase 8's
  `trello-sync` Fitting; both ship for one phase to allow
  migration.
- **2026-05-08** — Phase 2 implementation observations from T6/T7:
  (a) gateway uses `/jobs` endpoint for system-triggered prompts,
  not `/chat` — `/chat` is for user-initiated turns only.
  Future briefs should reference `/jobs` directly.
  (b) `personal-operative.report_channel` config already owns
  "where do system messages go" — new Fittings should consume it
  rather than introducing parallel `channel_target` configs.
  (c) Validator forces `automations + cli-skill` combo for
  wrapper-script Fittings; tracked in parking lot as a refactor.
- **2026-05-08** — Phase 3 implementation adaptations from T2/T4:
  (a) Static view registry in the frontend instead of dynamic
  import per Fitting. Sufficient for seed-only Fittings; revisit
  when third-party Fittings ship views.
  (b) `cli-skill` shape now valid under `knowledge-base` Faculty —
  minimal validator change to unblock Documents (one Fitting
  pairing Operative-facing CLI with user-facing UI). Broader
  Faculty/shape refactor still parked.
  (c) Edit view in Documents is plain textarea, not tiptap.
  Pragmatic v1; the upgrade path to tiptap is documented but
  deferred. Markdown render in read view is a mini-renderer, not
  full react-markdown — also pragmatic.
- **2026-05-08** — Phase 4 implementation observations from T1/T2/T6:
  (a) SDK exposes `Query.interrupt()` as a first-class
  cancellation primitive. Phase 4 T6 uses it directly; plan-as-
  written anticipated process-tree termination as fallback —
  not needed.
  (b) Sub-agent invocation chose Variant A (CLI-shape, looks like
  every other Fitting) over Variant B (external claude process)
  or Variant C (gateway-internal). Decision recorded in
  `scripts/spike/sub-agent/report.md`. Future Fittings that want
  sub-agent spawning have an idiomatic reference.
  (c) Setup hook re-runs on every Operative up
  (`runner.ts:87-90`), so the SDK symlink coding-subagent depends
  on is auto-restored. Means setup hooks are safe places to
  establish runtime invariants; they don't drift between ups.
- **2026-05-11** — **Phase 5 implemented: Workbench shell area + 4
  seed Fittings.** Added `terminal`, `screen-share`,
  `worktree-management`, `session-view` Faculties (order 15–18,
  `family: "workbench"`). Workbench shell at `/workbench` renders
  installed Workbench Fittings as tabs. 4 seed Fittings:
  `terminal-armory-default` (re-homes Trenches TrenchesPanel + WS
  server), `screen-share-default` (re-homes screencapture capture
  loop), `worktree-management-sequoias` (basic git worktree CRUD
  derived from Sequoias), `session-view-sequoias` (reads
  ~/.sequoias/state.json for session badges). `screen-share` added
  to capabilityKinds. Naming: Workbench (tool area) vs Armory
  (Fitting registry browser at /armory) — resolved collision.
  T8 (Sequoias retirement) deferred — 3-day daily-use gate.
- **2026-05-11** — **Phase 6 added: Outposts (multi-machine
  bridge).** New Faculty (`outpost`, cardinality many) with a
  small bridge process running on each remote Mac. Host machine
  runs Garrison + the Operative; bridges expose RPC + event
  streams over WebSocket-via-Tailscale for `process.*`, `fs.*`,
  `git.*`, `exec.*` operations. Workbench Fittings (worktree,
  terminal, session-view) gain outpost-selector to operate on any
  connected machine. Operative gains an `outpost-actions` skill
  that exposes the same operations as agent-callable tools. Vault
  sync is the first bridge-driven service (host → outposts
  unidirectional v1). One Operative on one host; bridge gives it
  hands, not brains. SSH used only for the one-time bootstrap.
  Bumped: Automations Phase 7, Tasks Phase 8. Driven by the
  user's three-Mac workflow (automation/development/portable).
- **2026-05-08** — **Phase 5 reframed: Trenches → Workbench (then
  called Armory).** Earlier Phase 5 specced a "Trenches" tab as
  Garrison-core (a separate top-level area). That was a category
  error against the platform thesis ("Faculties + Fittings compose;
  the shell renders what's installed"). Reframed: tools are a *family
  of Faculties* (Workbench) — `worktree-management`, `session-view`,
  `terminal`, `screen-share` — with Fittings filling them. The
  Workbench area in the shell renders dynamically based on installed
  Fittings. Verification milestone: decompose Sequoias (standalone
  worktree-manager app) into Workbench Fittings.
- **2026-05-05** — Memory Fitting is the Claude-Code-native
  `memory-compiler` hook + Claude Code's own memory mechanism. Not
  ported from EKOA.
- **2026-05-05** — Slack Channel is ported from **Ekus** (not EKOA),
  webhook-based.
- **2026-05-05** — Reference projects clarified: Ekus = Slack,
  Trello, channels in general. EKOA = Automations only (Phase 7).
- **2026-05-05** — UI extension contract stays per-tab-single-pane
  through Phase 5. Extended at Phase 7 when Automations forces the
  redesign. Phase 1/2 Fittings accept the retrofit cost.
  *(Superseded 2026-05-08: Phase 3's contract v2 brought the
  redesign forward, and Phase 5's Armory reframe means Armory
  Fittings use contract v2 from day one rather than sidestepping
  it.)*
- **2026-05-05** — Hat selection is **auto-detect from context**
  only. No explicit toggle in v1. Detection lives in the
  Orchestrator; Soul declares the hats. Revisit if misfires
  accumulate.
- **2026-05-05** — Phase 1 sequencing (post-investigation): add
  `setup` hook to spec + runner (small, unblocks everything else) →
  patch `CAPABILITIES.md` for `any` (1 line) → port awc-gateway-slack's
  `gateway.js` into `http-gateway` if needed → port `slack-adapter.js`
  + `stop-to-gateway.sh` into new `slack-channel` Fitting → port
  Ekus `heartbeat/trello.py` + Trello skill into `trello-data-source`
  → fix Memory Fitting (setup script that clones compiler + wires
  hooks + schema rename) → Soul + Orchestrator rewrite (uses the
  `cardinality: any` mechanism + memory query discipline). Trello
  and Slack are mostly independent and can run in parallel.
- **2026-05-05** — Orchestrator becomes composition-aware **via the
  capability graph**, not hardcoded Faculty lists. Declares one
  `consumes` entry per capability kind with `cardinality: any`.
  Runner injects the resolved provider list into the system prompt
  at assembly time. Verified in investigation: `cardinality: any`
  is already wired end-to-end.
- **2026-05-05** — Prompt-flow ordering: hat auto-detect runs
  *before* the classifier. Hat = which Soul flavor. Classifier =
  how much process. Orthogonal, run in that order.
- **2026-05-05** — Phase 1 done explicitly includes a runtime
  assertion that the Orchestrator's composition awareness fires
  (Operative lists/de-lists Trello based on whether it's selected).
- **2026-05-05** (post-investigation) — Slack source corrected:
  port from `~/Projects/awc-gateway-slack/` (real webhook adapter +
  channel-agnostic gateway), not Ekus. Ekus's "Slack" is poll-based
  curl from inside a session.
- **2026-05-05** (post-investigation) — Capability resolver wildcard
  already exists end-to-end as `cardinality: "any"`. No spec
  extension needed; just a one-line patch in `CAPABILITIES.md`.
- **2026-05-05** (post-investigation) — Memory Fitting wraps the
  existing `~/.claude/memory-compiler/` (Python, three Claude Code
  hooks, compile script). Compiled output is already at
  `~/Projects/ekus/obsidian-vault/Compiled/`. The seed Fitting today
  is a placeholder; "import existing memory" dissolves into "point
  the Fitting at the same vault path."
- **2026-05-05** (post-investigation) — `http-gateway` should
  consider absorbing `awc-gateway-slack/gateway.js` (146 lines,
  stdlib, channel-agnostic FIFO pairing). Ekus's 2090-line FastAPI
  gateway is out of scope for Phase 1.
- **2026-05-05** (post-investigation) — Trello seed Fitting is a
  4-line stub. Real port: `mac-mini/gateway/heartbeat/trello.py`
  from Ekus + the Ekus Trello skill prompt.
- **2026-05-05** (post-investigation) — EKOA has *two* automation
  engines (`cortex/` Playwright, `automato/` raw CDP). Phase 7 must
  pick before porting. Captured for Phase 7.
- **2026-05-05** — New `setup` Fitting lifecycle stage adopted.
  Runs before `verify` on every `up`. For prerequisites APM can't
  satisfy: clone repos, run `uv sync`, write to host config, install
  binaries. Schema same shape as `verify` plus `idempotent: bool`.
  Spec changes: `METADATA.md`, `AGENTS.md` §5, `V1_DOD.md`. Runner
  test for ordering.
- **2026-05-05** — Memory Fitting does *not* bundle the compiler.
  The compiler is its own GitHub repo (URL TBD); the Fitting ships
  a setup script that clones it to `~/.claude/memory-compiler/` if
  missing, runs `uv sync`, wires the three hooks into
  `~/.claude/settings.json`. Schema rename:
  `compiled_memory_path` → `compiled_memory_dir`.
- **2026-05-05** — Memory Faculty cardinality stays `single`.
  Fitting wraps the compiler. Claude Code's native auto-memory at
  `~/.claude/projects/.../memory/MEMORY.md` is left alone — Garrison
  doesn't manage it.
- **2026-05-05** — Memory usage discipline added to Orchestrator
  prompt: index is a map, query for specifics, don't pull the full
  corpus into context.

---

## Open questions parking lot

Anything raised in conversation but not yet resolved.

(Phase 1 entries removed 2026-05-06; phase complete.)

- (Phase 2) Project index depth: shallow + drill-in (leaning yes).
- (Phase 2) Project index Faculty: `knowledge-base` Fitting vs.
  `skills` Fitting + Orchestrator config (leaning skills + config).
- (Phase 2) Calendar Faculty: data-source / automation / both.
- (Phase 2) Heartbeat approval surface: Slack thread reply (leaning
  yes).
- (Phase 3) Editor choice: tiptap (lean) vs `@uiw/react-md-editor`
  vs Monaco. Confirm at impl start.
- (Phase 3) Artifact storage root: `<composition-dir>/artifacts/`
  (lean) vs `~/Projects/garrison-artifacts/<composition-name>/`
  vs user-configurable.
- (Phase 3) Artifact metadata format: sidecar `.meta.json` per
  file (lean) vs central index file.
- (Phase 3) Cross-tab URL scheme: `garrison://` (lean) vs hash
  routing. Verify integration with the existing Garrison frontend
  router.
- (Phase 3) Memory Fitting UI surface — separate phase, separate
  Fitting. Likely structurally similar to Documents but kept
  isolated. Capture phase number when Phase 3 is closer.
- (Phase 3) Per-project document scoping: when Phase 2's project
  index lands, should documents be scoped per-project? Likely yes
  eventually; v1 = flat per composition.
- (Phase 4) Session model: A vs B vs C (leaning C with B as
  fallback). Verify SDK sub-agent ergonomics first.
- (Phase 4) Planning tool source: built-in vs. own skill.
- (Phase 5) Default Claude Code flags for the Open-Orchestrator
  / Open-Claude-Code launch presets on the `terminal` Fitting:
  `--dangerously-skip-permissions` plus what else?
- (Phase 5) Hosts file location: `~/.garrison/hosts.json` (per-user
  global) vs per-composition (leaning per-user global, since
  hosts follow the human, not the Operative). *(Mostly superseded
  by Phase 6 Outposts — hosts list moves into the Outposts
  Faculty config.)*
- (Phase 5) Screen share: periodic-screenshots vs full streaming.
- (Phase 5) Terminal busy-detection heuristic — output-in-last-2s
  vs prompt-string redraw detection (lean simple for v1).
- (Phase 5) Workbench pane layout — single-active vs tabbed-multi
  vs split-grid. Resolved at impl: tabbed per the Phase 5.5
  shipped UI.
- (Phase 5) Browser Faculty scope for v1 — full Fitting or
  deferred? Lower priority than terminal/worktree/session/
  screen-share. Deferred at Phase 5 ship.
- (Phase 5) APM UI Fitting parity gap-find — does the existing
  UI Fitting mechanism cover what Workbench needs (action
  declarations, provides/consumes wiring through to UI)? Resolved
  at Phase 5 ship via the contract v2 work from Phase 3.
- (Phase 6) Protocol choice for v1: JSON over WebSocket (leaning)
  vs gRPC vs custom binary. Revisit if framing overhead bites.
- (Phase 6) Auth details: token-on-handshake confirmed for v1;
  rotation policy and refresh-token semantics open.
- (Phase 6) Bridge update mechanism for protocol version
  bumps. v1 = manual re-bootstrap; v2 = self-update path.
- (Phase 6) Filesystem path semantics across machines (tilde
  expansion, home-dir differences). v1 = absolute paths, tilde
  expansion on the remote side.
- (Phase 6) Connection multiplexing: share one WebSocket per
  outpost (leaning) vs separate per consumer. Share requires
  operation IDs for routing.
- (Phase 6) Failure UI: how to surface bridge disconnects
  mid-operation (worktree create fails, terminal hangs, etc.).
- (Phase 6) Host-side WebSocket server location — HTTP gateway
  (lean) vs a separate process. Confirm gateway can host both
  HTTP and WS routes during T0/T2.
- (Phase 6) Vault-sync direction: host → outposts v1; full
  bidirectional deferred.
- (Phase 7) Pick automation engine: EKOA `cortex/` Playwright
  in-process vs `automato/` raw CDP. Resolve before porting.
- (Phase 8) Trello-sync Faculty kind: new `data-sync` kind vs
  reuse `data-sources` vs reuse `automation-runner` (leaning new
  kind if more bidirectional syncs follow).
- (Phase 8) Autonomy floor configuration: tier ≤ N runs autonomously,
  tier > N requires plan-then-approve. Per-user, possibly per-task-
  label override.
- (Phase 8) Multi-board / per-project task scoping when Phase 2
  project index is solid.
- (Phase 8) Real-time UI push: polling for v1, SSE/websocket if
  load justifies it.
- (Phase 8) Trello-sync conflict resolution: last-write-wins by
  `updated` timestamp for v1; surface unresolvables to user.
- (Future / un-phased) Garrison-as-AI-composer (advisory/validation
  flavor) — build when composition complexity warrants it.
  Triggers: Fitting registry breadth, contradicting `for_consumers`
  blocks, novice users needing help. See cross-cutting section.
- (Future / un-phased) **Faculty/shape validator refactor.**
  Surfaced during Phase 2 T7: the validator currently only accepts
  `automations + cli-skill` for Fittings whose surface is a wrapper
  script (not an operative-facing tool). The morning-briefing
  Fitting and the calendar Fitting both took this combo as a
  workaround. Phase 3 T4 added a second narrow exception
  (`knowledge-base + cli-skill`) for Documents. Faculty/shape is
  conflating "what the operative sees" with "how the Fitting is
  invoked." Worth a clean refactor when a third exception comes
  up — the rule of three.
- (Future / un-phased) **Documents editor: textarea → tiptap.**
  Phase 3 T4 shipped with plain textarea for the edit view.
  Upgrading to tiptap (or another markdown editor) is documented
  in the Fitting itself; revisit when document editing becomes a
  primary workflow rather than occasional polish.
- (Future / un-phased) **Documents read view: mini-renderer →
  full react-markdown.** Phase 3 T4 ships with a small custom
  markdown renderer. Migrate to `react-markdown` when there's
  demand for tables, footnotes, complex link rewriting, or other
  features the mini-renderer doesn't cover.
- (Future / un-phased) **Frontend view registry: static → dynamic
  imports.** Phase 3 T2 ships with a static registry of view
  components (compile-time). When third-party Fittings start
  shipping their own views, dynamic imports become necessary;
  until then, static is simpler and faster.
- (Future / un-phased) Memory Fitting UI surface — likely Phase 7
  or later. Structurally similar to Documents UI, separate Fitting,
  separate scope.
- (Future / un-phased) **Testing & Validation Faculty.** For
  autonomous flows: a Faculty that validates the Operative's work
  before declaring it done. **Resolved 2026-05-06:** Testing and
  Automations are *separate Faculties* but Testing
  `consumes: { kind: automation-runner, cardinality: optional-one }`
  — testing scenarios that need browser automation get the
  Automations infrastructure; testing scenarios that just run a
  bash command don't. No duplication. Automations grows the
  features needed for both: progressable steps, feedback for
  improvement, video recording, video access. Testing itself is
  thin — discipline, validation logic, when-to-run rules.
  Videos produced by Automations land in the Artifact Store under
  `automations/`, viewable from the unified browser.
- (Future / un-phased) **Voice Faculty.** Two capabilities:
  *playback* (read assistant replies aloud) and *recording* (user
  speaks, gets transcribed). Channel-aware delivery:
  - In Garrison's chat UI: play button per message, uses an
    in-process voice provider.
  - In Slack: synthesize audio file, post via Slack's audio
    message support.
  - In any other channel: synthesize audio file via the Artifact
    Store (`voice/` namespace), send a `garrison://artifacts/<id>`
    link.
  - The Faculty itself decides delivery mechanism based on the
    capabilities of the host channel — channels probably need to
    declare "I can render audio inline" via a capability flag.
  - Real-time bidirectional voice (live conversation) is much
    later — explicitly future work. The user is already
    struggling to make this work outside Garrison; not bringing
    that complexity in until the standalone problem is solved.
  - Reuses the Artifact Store layer rather than implementing its
    own storage.