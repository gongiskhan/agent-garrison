# Fittings Migration Plan — promote Claude Code primitives to first-class Fittings

**Run:** `docs/autothing/runs/20260624-214443-357bf40f`
**Status:** Phase 0 (inventory + grouping) complete · Faculty design + scope **pending Gonçalo confirmation** (the brief mandates this checkpoint).
**Branch:** `main` (no new branch — hard rule).

> Goal: reverse the Compose page's separate "Claude Code components" group. Every skill/hook/MCP/plugin
> becomes a proper **Fitting** with a meaningful human description, an explicit `provides`/`consumes`
> contract, and **editable setup instructions**. The words *skill, hook, MCP, plugin* stop being the thing
> a user composes — they survive only as an internal `component_shape` kind on the fitting. Non-technical
> users must understand the abstraction without ever learning what those primitive types are.

---

## 0. How discovery + materialization work today (Phase 0 map)

Verified against the code (file:line). **We reuse these — no parallel mechanism is invented.**

| Primitive | Discovered from | Discovery code | Materialized by |
|---|---|---|---|
| **Skill** | `~/.claude/skills/<name>/SKILL.md` (dir + SKILL.md) | `scanClaudeFiles()` `claude-scan.ts:46-79` | APM (single writer) via `apmInstall()` through the `~/.garrison/global-composition/.claude` symlink |
| **Command / Rule** | `~/.claude/commands/*.md`, `~/.claude/rules/*.md` | `scanClaudeFiles()` `claude-scan.ts:59-76` | APM |
| **Hook** | `~/.claude/settings.json` `.hooks` (`_garrison` marker ⇒ fitting-owned) | `readSettingsRaw()` `claude-settings-file.ts:59-72` | Garrison-direct (`hooks-crud.ts`); fitting-owned tagged `_garrison: fitting:<id>` |
| **MCP** | `~/.claude.json` `.mcpServers` (**primary** — confirmed). `~/.claude/mcp.json` is **fallback only** when `~/.claude.json` is absent | `readMcpServerNames()` / `readClaudeJson()` `claude-scan.ts:136-154`, `claude-json.ts:38-53` | Garrison-direct (`mcp-user.ts` → `~/.claude.json`; legacy `mcp-writer.ts` → `~/.claude/mcp.json`) |
| **Plugin** | `~/.claude/plugins/installed_plugins.json`; enablement in `settings.json` `.enabledPlugins` | `readInstalledPlugins()` `claude-scan.ts:99-126` | Claude Code installs; Garrison removes (`plugin-writer.ts`) |

**Confirmed:** MCP discovery points at `~/.claude.json` (not `~/.claude/mcp.json`). The on-disk
`~/.claude/mcp.json` exists but is `{"mcpServers":{}}`, and the code only reads it when `~/.claude.json` is
missing. No change needed there.

**State model** (`primitive-state.ts`): file surfaces (skill/command/rule) are **owned** (in the global
`apm.lock.yaml`) or **loose** (on disk, not in the lock); config-entry surfaces (hook/mcp/plugin) are
**enabled** or **parked** (`~/.garrison/parked/`). "Promote" = adopt a loose file into the APM lock.

**The fitting model** (`metadata.ts`, `types.ts`): the `x-garrison` block already carries everything we
need:
- `component_shape` — enum `script · agent-instructions · manual-instructions · plugin · skill · cli · hook · system-prompt · cli-skill · mcp`. **This is the existing "internal kind" the brief asks for** — `skill`/`hook`/`mcp`/`plugin` are already values here, recorded on the fitting and nowhere user-facing. No new concept required.
- `faculty` — one of the 9 roles.
- `provides` / `consumes` — the contract (kind + name + cardinality `one|optional-one|any`).
- `setup` — **today a single `SetupStep { command, idempotent, timeout_ms }`** (runner.ts runs it during `up()`).
- `verify`, `ui`, `summary`, `for_consumers`, `config_schema`, `own_port`, `lifecycle`, …

**The Compose third group** (`StationGrid.tsx:342-349`): titled **"Claude Code components"**, blurb
*"Skills, hooks, agent tools (MCPs), and plugins from ~/.claude…"*, rendering four count-tiles
(`COMPONENT_TILES` `:395-400`: Skills / Hooks / Agent Tools / Plugins) sourced from the live Quarters
StateModel (`/api/quarters`). **This is exactly what we reverse.** The first two groups are
faculty-driven: "Every agent needs these" (essential) and "Optional roles" (non-essential).

**The fitting detail view** (`FittingSurfacePanel.tsx` → `FittingOverview.tsx`): read-only sections *How it
works · Provides · Consumes · Views*. **The `setup` field is never displayed.** This is where the new
editable **Setup Instructions** section goes.

**Modes ↔ faculties** (`fittings/seed/modes/modes.json`): each mode declares a `faculties: [...]` array it
activates. Gary (everyday) → `memory, channels`; **Joe (dev)** → `runtimes, memory`; James (architect) →
`memory`. So the modes config **does** encode a dev signal: a faculty only activated by the dev mode (e.g.
`runtimes`) is dev-oriented; one active in the everyday mode (`channels`, `memory`) is agent-oriented. The
signal is real but **partial** — modes only reference `runtimes/memory/channels`, so it confirms the *rule*
without classifying every faculty. We use it as the anchor, not the whole answer.

---

## 1. Inventory (Phase 0 deliverable)

### 1a. Standalone skills — `~/.claude/skills/` (31 with `SKILL.md`)

| Skill | Source | Plain-language purpose |
|---|---|---|
| `autothing` + `autothing-{plan,implement,test,review,adversarial-review,adversarial-test,design-audit,walkthrough,report,validate,parallel-work,project-foundation}` (13) | `~/.claude/skills/autothing*/` | Autonomously build software end-to-end and prove it works (an orchestrator + its pipeline steps) |
| `csg-{setup,sync,complete}` + `csg-common` (4) | `~/.claude/skills/csg-*/` | A corporate remote-dev workflow (csg-common is the shared internal library the other three use) |
| `walkthrough` | standalone | Record a narrated, self-verified video proving a finished change |
| `garrison-browser` | standalone | Inspect the browser pane running beside Garrison |
| `playwright-cli` | standalone | Drive a real browser to test web pages |
| `ekoa-architecture-audit` | standalone | Deliberate architecture/invariant audit of Ekoa/Garrison codebases |
| `skill-creator` | standalone | Guide for authoring new skills |
| `skill-improver` | standalone | Nightly batch reviewer that turns feedback into skill improvements |
| `claude-docs-consultant` | standalone | Consult official Claude Code docs |
| `frontend-design` | standalone | Build distinctive production-grade web UIs |
| `huashu-design` | standalone | Hi-fi HTML prototyping, design variants, expert review |
| `gcp` | standalone | Google Cloud Platform operations |
| `pdf` | standalone | Extract/create/merge/split/fill PDFs |
| `notebooklm` | standalone | Google NotebookLM API (podcasts, notebooks from sources) |
| `watch` | standalone | Watch/analyze a video (download, frames, transcript) |
| `caveman` | standalone | Ultra-compressed communication style |

> Name collisions to resolve in grouping: `frontend-design`, `pdf`, `skill-creator` exist **both** as
> standalone skills **and** bundled inside plugins (see 1d).

### 1b. Hooks — `~/.claude/settings.json` `.hooks` (38 groups; almost all loose plumbing)

| Cluster (by what writes/owns it) | Events | State |
|---|---|---|
| **herdr agent-state** (`herdr-agent-state.sh`) | PermissionRequest, PreToolUse, Stop, SessionEnd, UserPromptSubmit | loose |
| **basic-memory sync** | PreCompact, SessionEnd | loose (co-refs the `basic-memory` MCP) |
| **coord priming** (coord-beads-prime, coord-mcp scripts) | SessionStart, UserPromptSubmit | loose (co-refs the coord MCPs) |
| **codegraph autoinit** (`codegraph-autoinit.sh`) | SessionStart | loose (co-refs the `codegraph` MCP) |
| **autothing goal-loop** (`goal-stop.sh`, `goal-sessionstart.sh`) | Stop, SessionStart | loose (co-refs the `autothing` skill family) |
| **harmonika orchestrator relay** | Stop | loose (external) |
| **observability relays** (curl → 127.0.0.1:7081/7086) | Notification, PostToolUse, Stop, UserPromptSubmit | loose; the `_garrison: fitting:dev-env`-tagged copies are **already owned by the dev-env fitting** |

> Honest read: hooks are overwhelmingly **machine/infra plumbing**, not capabilities a user "composes."
> Several are already fitting-owned (dev-env). The rest co-reference a skill/MCP and should ride along with
> that fitting rather than appear as standalone user-facing fittings.

### 1c. MCP servers — `~/.claude.json` top-level (5)

| MCP | Config | Purpose |
|---|---|---|
| `codegraph` | stdio `codegraph serve --mcp` | Code-intelligence graph over the workspace |
| `serena` | stdio `serena start-mcp-server` | LSP-grade symbol search + edits |
| `basic-memory` | stdio `basic-memory mcp` | Personal knowledge/memory store (provides a `memory-store`) |
| `coord-agentmail` | http `127.0.0.1:8765/mcp` | Cross-session file leases + agent mail |
| `coord-mcp` | stdio node `fittings/seed/coord-mcp/scripts/server.mjs` | Planning-gate coordination — **already a Garrison seed fitting in this repo** |

### 1d. Plugins — `~/.claude/plugins/installed_plugins.json` (5; all enabled)

| Plugin | Bundles | Purpose |
|---|---|---|
| `frontend-design@claude-plugins-official` | skill `frontend-design` | Frontend design |
| `agent-sdk-dev@claude-plugins-official` | command `new-sdk-app` + agents `agent-sdk-verifier-{py,ts}` | Claude Agent SDK development |
| `document-skills@anthropic-agent-skills` | **17 skills**: algorithmic-art, brand-guidelines, canvas-design, claude-api, doc-coauthoring, docx, frontend-design, internal-comms, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing, xlsx | Office documents + a grab-bag of authoring skills |
| `obsidian@obsidian-skills` | 5 skills: defuddle, json-canvas, obsidian-bases, obsidian-cli, obsidian-markdown | Create/edit Obsidian vault files |
| `ui-ux-pro-max@ui-ux-pro-max-skill` | UI/UX design intelligence (50 styles / 21 palettes / …) | UI/UX design reference |

**FINDING: inventory complete, 31 skills, 38 hooks, 5 mcps, 5 plugins** (+ ~25 skills bundled inside the 5 plugins).

---

## 2. Grouping — one fitting per logical unit (brief's priority rules)

Rules applied, in priority order: **(1)** plugin membership is authoritative; **(2)** else group only on
strong evidence (shared dependency + shared name root, or a clear invoke-co-reference); **(3)** else keep
separate and record the suspicion.

### Plugin fittings (rule 1) — 5
- **Frontend Design** (`frontend-design` plugin) — bundles the `frontend-design` skill.
- **Agent SDK Dev** (`agent-sdk-dev` plugin) — bundles `new-sdk-app` + the two SDK verifier agents.
- **Document Skills** (`document-skills` plugin) — bundles all 17 skills as one fitting.
- **Obsidian** (`obsidian` plugin) — bundles the 5 obsidian skills.
- **UI/UX Pro Max** (`ui-ux-pro-max` plugin) — single design-intelligence skill.

### Strong-evidence groups (rule 2)
- **Autonomous Software Building** = `autothing` + its 12 `autothing-*` steps. Evidence: shared name root **and** clear co-reference (autothing documents invoking each sub-skill). → 1 fitting. + rides the autothing goal-loop hooks (Stop/SessionStart).
- **Corporate Remote-Dev Workflow** = `csg-setup` + `csg-sync` + `csg-complete` + `csg-common`. Evidence: shared name root + `csg-common` is the **explicit shared library** ("INTERNAL LIBRARY for the CSG workflow"). → 1 fitting.
- **Session Coordination** = `coord-mcp` + `coord-agentmail` + the coord priming hooks. Evidence: both are the same coordination stack (shared "coord" root + co-reference; `coord-mcp` already ships in-repo). → 1 fitting.
- **Code Intelligence (codegraph)** = `codegraph` MCP + its `codegraph-autoinit` SessionStart hook (co-reference). → 1 fitting.
- **Personal Memory (basic-memory)** = `basic-memory` MCP + its PreCompact/SessionEnd sync hooks (co-reference). → 1 fitting. (Provides `memory-store` → Memory faculty.)

### Standalone fittings (rule 3) — kept separate
`serena`, `walkthrough`, `garrison-browser`, `playwright-cli`, `ekoa-architecture-audit`,
`claude-docs-consultant`, `huashu-design`, `gcp`, `pdf` (standalone), `notebooklm`, `watch`, `caveman`,
`skill-creator` (standalone), `skill-improver`.

### Suspicions recorded for human review (rule 3 — NOT merged)
- `skill-creator` + `skill-improver` — both skill-meta-tooling and share the `skill-` root, but neither invokes the other and there's no shared dependency. **Kept separate.**
- `garrison-browser` + `playwright-cli` — both browser-driving, no shared root/dependency. **Kept separate.**
- `frontend-design`: exists as a standalone skill **and** inside the `frontend-design` plugin **and** inside `document-skills`. `pdf`/`skill-creator`: standalone **and** inside `document-skills`. **Plugin membership wins for the plugin-bundled copy; the standalone copy is a separate fitting.** Flag the duplication so the user can later dedupe/park one side.
- The loose observability/herdr/harmonika relay hooks have no owning skill/MCP — they are pure infra. **Not promoted to user-facing fittings** (recommendation: keep as platform plumbing; the dev-env-owned ones already belong to a fitting).

---

## 3. Proposed faculty design (PENDING CONFIRMATION — brief §"confirm with Gonçalo")

**Unchanged essential set (4):** Orchestrator, Memory, Channels, Gateway. *(Not touched.)*

**Two independent axes, not conflated:**
- **Structural:** essential vs optional (existing `essential` flag on `FacultyDefinition`).
- **Presentation only:** an **Agent** vs **Dev** display header in Compose. New `tier: "agent" | "dev"`
  display tag on each faculty — orthogonal to essential/optional (an optional faculty can be Agent; an
  essential faculty can sit under either header).

**Agent-vs-Dev rule (anchored on modes):** a faculty is **Dev** if it is only relevant while doing
development work — the kind of thing the dev mode (Joe) activates; otherwise **Agent** (everyday base
operative). Dual-use ⇒ place by primary non-technical use, leaning **Agent** (the base operative is always
on). Genuinely-equal dual-use ⇒ flagged for review, not silently chosen.

**Proposed NEW optional faculties** for the promoted fittings (purpose-named, never primitive-named):

| New faculty | Tier | What it's for (plain) | Fittings that fill it |
|---|---|---|---|
| **Knowledge** | Agent | Create, edit, and organize documents and notes | Document Skills, Obsidian, pdf, notebooklm |
| **Research & Media** | Agent | Find things out and understand media | watch, claude-docs-consultant *(+ deep-research)* |
| **Software Building** | Dev | Write, test, and ship code autonomously | Autonomous Software Building, walkthrough, ekoa-architecture-audit, csg workflow, agent-sdk-dev |
| **Code Intelligence** | Dev | Understand and navigate codebases | codegraph, serena |
| **Design Studio** | Dev | Design and prototype user interfaces | frontend-design, huashu-design, ui-ux-pro-max |
| **Browser & QA** | Dev | Drive a real browser to build and verify | playwright-cli, garrison-browser |
| **Coordination** | Dev | Keep parallel work sessions out of each other's way | Session Coordination |

**Existing optional faculties keep their tier:** `runtimes` (Dev — confirmed by modes/Joe), `observability`
(Dev), `sessions` (Dev), `surfaces` (Dev), `modes` (Agent — it shapes the everyday persona).
`gcp` and `skill-creator`/`skill-improver`/`caveman` placements: gcp → Software Building (dev ops);
skill-* → a Dev "meta" home (proposed: Software Building); `caveman` is a pure communication style →
Agent (could attach to `modes`). **These three are flagged dual-use/awkward for your call.**

> This is **7 new optional faculties**. CLAUDE.md cautions against faculty sprawl ("new Faculties land only
> when a real Fitting needs one"). A coarser alternative is **2 faculties** ("Agent Skills" + "Dev Tools")
> or **~4**. Granularity is a confirmation question below.

---

## 4. Scope question — how literally to "promote every primitive" (PENDING CONFIRMATION)

The inventory shows the live `~/.claude` is mostly **personal, machine-specific tooling and plumbing**.
Three viable shapes, very different footprints:

- **A — Discovery-driven projection (recommended).** Reuse the live Quarters discovery. Render each
  discovered unit / plugin-bundle as a **fitting card** with an authored description + contract + editable
  setup, `component_shape` demoted to internal metadata, placed into the optional faculties under
  Agent/Dev headers. The authored metadata lives in a **sidecar** keyed by the discovered primitive;
  materialization stays the existing promote/APM/presence path. **No personal primitives committed as repo
  seed packages.** Holds the abstraction, scales to the real environment, reuses everything.
- **B — Commit a real `fittings/seed/` APM package per logical unit.** The most literal reading. Heaviest;
  writes your personal `~/.claude` setup into the Garrison repo; most of it doesn't generalize.
- **C — Hybrid.** Projection for personal primitives (as A) **plus** a small number of real seed packages
  for the genuinely general, shippable units (e.g. `coord-mcp` already is one; the document/obsidian
  plugins).

---

## 5. Implementation plan (after confirmation)

Regardless of scope, these land:

1. **Schema — setup as ordered steps.** Extend `x-garrison.setup` to accept **either** the current single
   `SetupStep` (back-compat) **or** an ordered array of steps `[{ command, idempotent?, timeout_ms?, label? }]`.
   `runner.ts runSetupHooks/runFittingSetup` iterates the steps in order (same env injection, same abort-on-nonzero).
   Same field the installer reads ⇒ one source of truth. (`metadata.ts`, `types.ts`, `runner.ts` + tests.)
2. **Faculty display tier.** Add `tier?: "agent" | "dev"` to `FacultyDefinition` (`types.ts`, `faculties.ts`).
   Purely presentational, like `essential`. Add the new optional faculties (per confirmation).
3. **Compose rendering.** Replace the "Claude Code components" third group with **Agent faculties** and
   **Dev faculties** headers (grouping the faculty tiles by `tier`); the promoted fittings appear as
   fitting cards within their faculty, not as primitive-type tiles. (`StationGrid.tsx`.)
4. **Setup Instructions editor.** New visible, inline-editable section on the fitting detail view
   (`FittingOverview`/`FittingSurfacePanel`) — ordered steps with add / edit / remove / reorder, autosaving
   (no Save button — Quarters convention) back to the `x-garrison.setup` steps the installer reads.
   API route + persistence via the existing metadata write path.
5. **Vocabulary sweep.** Ensure *skill/hook/MCP/plugin* never appear as the thing composed in user-facing
   copy; they remain only as `component_shape` internal metadata.

Each UI slice carries a committed test + walkthrough evidence per the autothing gates.

---

## 6. Decisions — CONFIRMED by Gonçalo (2026-06-24 checkpoint)
1. **Scope = Hybrid** (§4 C): discovery-driven **projection** for the personal primitives (authored
   descriptor sidecar, reusing live Quarters discovery + existing materialization) **plus** real
   `fittings/seed/` packages for the genuinely general/shippable units (`coord-mcp` already is one; the
   document/obsidian plugins). No mass-committing of personal `~/.claude` plumbing.
2. **Faculties = the 7 purpose-named optional faculties** (§3): **Knowledge**, **Research & Media** (Agent);
   **Software Building**, **Code Intelligence**, **Design Studio**, **Browser & QA**, **Coordination** (Dev).
   Essential 4 unchanged.
3. **Agent/Dev = modes-anchored rule, lean Agent for dual-use** (§3): `pdf`/`notebooklm`/`watch` → Agent;
   design skills → Dev (Design Studio); `gcp` → Dev (Software Building); `caveman` → Agent (attaches to `modes`).

## 8. Completion status (2026-06-24) — all slices SHIPPED + verified

| Slice | What shipped | Verification |
|---|---|---|
| s1 | `x-garrison.setup` accepts an ordered array of steps (back-compat single step), normalised to `SetupStep[]`; runner runs each in order, aborts on first non-zero | `metadata` + `runner-setup` tests; all 27 seed setups normalise; typecheck |
| s2 | `FacultyDefinition.tier` (`agent`/`dev`) + 7 new optional capability faculties (Knowledge, Research & Media [agent]; Software Building, Code Intelligence, Design Studio, Browser & QA, Coordination [dev]) | `faculties` + `docs-consistency` tests; FACULTIES.md + CLAUDE.md updated |
| s3 | Promoted-primitives catalog (24 authored Fittings) joined to live Quarters discovery + the `~/.garrison` override store; `/api/promoted-fittings` | `promoted-catalog` (23) + `promoted-overrides` (3) tests; verified against the real `~/.claude` (24/24 resolve) |
| s4 | Compose: **Agent faculties** / **Dev faculties** headers; the "Claude Code components" group replaced by promoted Fitting cards under their capability faculty | `composition-view` e2e (old group gone; cards render); design audit |
| s5 | `/fitting/promoted/[id]` detail + the inline, autosaving **Setup Instructions** editor (add / edit / remove / reorder) | `promoted-fittings` e2e (persist across reload; clear-baseline); design audit; 2 flow videos |
| s6 | Vocabulary sweep (0 primitive-type labels in the Compose flow) + hybrid coherence (`coordination` `packaged:true` references the real `coord-mcp` seed) | grep audit; `packaged`-seed guard test |

**Gates:** committed unit + e2e tests all green (91 in-scope unit + 5 e2e); typecheck + `next build` clean; design audit clean (vision-reviewed screenshots); **Codex cross-model review** found 5 real bugs (empty-override round-trip, autosave stale-write race, override-store lost-update, hook matcher-name matching, plugin marketplace false-positive) → all fixed → **round-2 approve**; same-model `simplify` pass applied (reuse the shared `setupStepSchema`; extract the override read helper).

### Known scope boundary (honest)
The Setup Instructions editor persists a **projected** Fitting's setup steps to the `~/.garrison/promoted-fittings.overrides.json` store — the projection metadata field. The **multi-step runner consumption** (`runFittingSetup` iterating steps, aborting on first non-zero) is wired **and tested** for composition-selected seed Fittings (s1). Feeding the override store's setup steps into the *projection promote/install* path for an already-installed discovered primitive is a **follow-on** — those primitives are already materialised on disk, so the steps are recorded, editable metadata for when one is promoted to a packaged Fitting. The packaged side of the Hybrid (real `fittings/seed/` apm.yml `setup:`) is fully consumed by the runner today.

## 7. Build slices (durable plan in `docs/autothing/runs/20260624-214443-357bf40f/FLOW_PLAN.md`)
- **s1** Schema: `x-garrison.setup` accepts an ordered **array** of steps (back-compat with the single step). `metadata.ts` + `types.ts` + `runner.ts` + tests.
- **s2** Faculty `tier: agent|dev` + the 7 new optional faculties. `types.ts` + `faculties.ts` + metadata enum + tests.
- **s3** Promoted-primitives **catalog** (authored descriptor sidecar) joined to live discovery + API. The "author each fitting" content.
- **s4** Compose rendering: **Agent faculties / Dev faculties** headers; promoted fittings replace the "Claude Code components" group. e2e + walkthrough.
- **s5** **Setup Instructions** editor on the fitting detail view — visible, inline, add/edit/remove/reorder, autosave to the setup steps. e2e + walkthrough.
- **s6** Vocabulary sweep + real seed package(s) exercising the hybrid path (setup-steps on `coord-mcp`). 
