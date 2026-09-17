I'll explore the three findings thoroughly. Let me start with parallel investigation across all three areas.
Let me dig into the Compose grid components, the taste skills, and the running fitting status files in parallel.
Now let me find the clone API route, the create-runtime flow, the drag-and-drop routing UI, and the theme token definitions.
The DnD lives in the orchestrator own-port Fitting UI. Let me read it, the clone lib, the theme tokens, and check for the taste skill v2 marker.
The orchestrator Fitting uses dnd-kit (`useDraggable`) with a click-to-arm fallback. Let me confirm the DnD context/sensors, read the theme tokens, and the clone lib.
Strong evidence on E12 and E14. Now the pinned-set (E19): let me read the default composition and scan seed fittings for lifecycle/own_port/eager flags and capability wiring.
Now let me map own_port, eager lifecycle, and capability wiring across the seed fittings to determine the pinned set.
Let me pin down the "eager" toggle mechanism and which own-port fittings auto-start, to finalize E19.
Let me read the actual eager-boot prefs and the standing automations the user relies on.
Let me confirm the reusable modal/editor pieces for E12(a).
I have thorough evidence across all three findings. Here is the structured report.

---

## FINDING-E12 — Compose grid, V1 clone flow, drag-and-drop

### (a) Compose grid component tree — what "Muster" can reuse

The Compose area is two files, both `"use client"`, both driven by `useAppShell()`:

**`src/components/compose/StationGrid.tsx`** (720 lines) — the `/compose` overview:
- `StationGrid` (38) — root; owns the cross-faculty search box (193-231) and the capability-issues/orchestrator-missing banners (233-273).
- `TierSection` (348) — the two grid headers ("Agent faculties" / "Dev faculties").
- `StationTile` (576) — one core-role slot card (verify pip, selected/available counts), links to `/compose/<facultyId>`.
- `SearchResults` (485) — **this is the "swap picker" today: a search box + results grid with an Add/Remove toggle per Fitting** (509-572). There is NO modal picker; discovery is the inline search.
- `CapabilityFacultyBlock` (413) / `PromotedFittingCard` (446) — the optional-capability card blocks.

**`src/components/compose/FacultyStation.tsx`** (937 lines) — the per-slot page `/compose/<facultyId>`. The most reusable pieces for a Muster page:
- `FittingCard` (477) — the swap-candidate card: Add / Remove / **Edit files** / **Clone** buttons, shape/clone badges, consumes/provides chips.
- `FittingConfigSection` (685) + `ConfigInput` (753) — **the config-form primitive**: renders `config_schema` fields as boolean / select / number / text inputs. This is what a Muster "config forms" column reuses directly.
- `OrchestratorGlobalConfig` (810) — **the orchestrator prompt/global-config panel**: `primary_runtime`, `projects_root`, `permissions_mode`, guardrails (`max_tasks_per_tick`, `max_tool_calls_per_tick`, `max_spend_per_day`). This is the closest existing thing to a "orchestrator prompt panel".
- `Cell` (438) — stat cell.

**`src/components/FittingEditor.tsx`** — a full **modal dialog** (`role="dialog"`, line 281), entry-driven, opened via `useAppShell().openFittingEditor(entry)` / `closeFittingEditor()`, rendered once at AppShell top level (`AppShell.tsx:432-437`). This is the reusable modal shell for a swap-picker/editor.

State plumbing all lives in `useAppShell()`: `composition`, `library`, `saveComposition({ selections })`, `refreshLibrary`, `openFittingEditor`, `busy`. Selection edits are pure `saveComposition({ selections })` calls; `defaultSelection(entry)` seeds config from schema defaults. A Muster page reuses `ConfigInput` + `FittingCard` + `SearchResults` + `OrchestratorGlobalConfig` + `FittingEditor` and this same AppShell plumbing — no new backend.

### (b) V1 clone flow (clone-a-fitting-from-template)

- **UI trigger:** `FacultyStation.cloneEntry` (`FacultyStation.tsx:128`) → `POST /api/fittings/<id>/clone`, then `refreshLibrary()`. Button in `FittingCard` (636-645), gated on `entry.localPath`.
- **API route:** `src/app/api/fittings/[id]/clone/route.ts` — POST, optional `{ newId }` body (default `<id>-copy`), returns 201 with the resolved entry. Also `.../clone-status/route.ts`.
- **Lib:** `src/lib/clone.ts` → `cloneFitting(sourceId, { newId })`. Copies the source into `fittings/local/<id>` as a full independent copy, skips `node_modules/apm_modules/.git/.DS_Store` but **keeps `.apm`** (that's where skill/hook source lives), rewrites ids (`apm_modules/_local/<name>`), writes provenance (`cloned_from` + per-file drift baseline in `clone.json`), registers as a first-class library entry. Symlink-escape guarded.

Note: there is **no `create-runtime` scaffold** anywhere in `src/` (grep is empty). The team lead's "create-runtime" example maps to *this* generic clone path — you clone e.g. `claude-code-runtime` to get an editable runtime copy. That's the only clone-from-template mechanism that exists.

### (c) Existing drag-and-drop target assignment (UNIFY-V1)

It is **not** in `src/components` — it lives in the orchestrator own-port Fitting UI: **`fittings/seed/orchestrator/ui/main.tsx`** (1710 lines, served on port 7087). It's the policy **matrix board**: a TARGETS TRAY of draggable target cards (runtime + model + effort) dropped onto an 18-task-type × 3-tier matrix, plus row/col/default drop zones and work-kind rails.

Built on **@dnd-kit** (real deps in root `package.json`: `@dnd-kit/core ^6.3.1`, `/sortable ^10.0.0`, `/utilities ^3.2.2`):
- `DndContext` at 1673; `useDraggable` on target cards (`TargetCard`, 489); `useDroppable` on `cell:<tt>:<tier>` (614), `row:<tt>` (644), `col:<tier>` (681), `def` (702).
- `onDragEnd` (1565) parses the droppable id and writes the assignment into the policy draft via `commit(producer)`.

### (d) iOS Safari touch — WORKS, with a first-class tap-to-pick fallback

@dnd-kit does not use HTML5 native DnD (which is broken on iOS Safari); it uses pointer/touch sensors. Sensors at `main.tsx:1556-1559`:
```
useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
useSensor(TouchSensor,   { activationConstraint: { delay: 150, tolerance: 8 } })
```
The 150 ms long-press delay is the standard iOS pattern that lets touch-scroll and drag coexist. Header comment (line 15): *"the inspector is a bottom sheet on narrow viewports, TouchSensor drives drag."*

A **tap-to-pick fallback already exists and is first-class**: click a tray card to "arm" it (`armedTarget` state 1555, `onArm` 501/1685; a plain click < 6 px travel arms rather than drags — comment 497-501), then tap a matrix cell/row/col to assign (`MatrixCell` onClick 635, `RowHeader` 665). The surface hint (601) documents both paths. So touch users who can't drag get a deterministic arm-then-tap path. **A Muster page inherits a working touch DnD pattern by copying this sensor config + arm/assign model.**

---

## FINDING-E14 — Taste fittings + theme tokens

### (a) Taste skills installed & loadable — CONFIRMED

- `~/.claude/skills/design-taste-frontend/SKILL.md` — present, 1206 lines, 122 headings, frontmatter `name: design-taste-frontend`, "Anti-Slop Frontend Skill". Skills carry no version field, but the seed `fittings/seed/taste/apm.yml` (version 0.1.0) description explicitly labels it **"design-taste-frontend v2"** (vendored from Leonxlnx/taste-skill, MIT, pinned commit).
- `~/.claude/skills/redesign-existing-projects/SKILL.md` — present, 178 lines, `name: redesign-existing-projects`, audit-first "Redesign Skill".
- Both are stationed in the default composition (`runtimes: taste`) and appear as loadable in the skill list (plus scoped `compositions/default:` variants). The `taste` seed Fitting provides/consumes nothing — it just drops these SKILL.md files into `~/.claude/skills`.

### (b) Garrison theme tokens — the shell design system

**Single source of truth: `src/app/globals.css` `:root` block (lines 5-25).** Plain CSS custom properties — no theme file, no dark mode (light-only, warm paper/ink/sage/brass "quartermaster" palette). Exact tokens a new page must build on:

| Group | Tokens |
|---|---|
| Paper (bg) | `--paper #fbf8f1`, `--paper-2 #f4ede0`, `--paper-3 #ece2cc` |
| Ink (text) | `--ink #18211c`, `--ink-2 #2a342e`, `--ink-mute #3a423d` |
| Sage (primary/success) | `--sage #2f4a3a`, `--sage-2 #3d6249`, `--sage-soft #eaf1e7` |
| Brass (accent/eyebrow) | `--brass #b4862a`, `--brass-2 #d8a82e` |
| Rule (borders) | `--rule #d6cdba`, `--rule-2 #c4b89f` |
| Mute (secondary text) | `--mute #66695f`, `--mute-2 #7d8077` |
| Alarm (error) | `--alarm #9b362d`, `--alarm-soft #f7eae6` |
| Warn | `--warn #b07215`, `--warn-soft #f6ecd0` |

**Fonts:** three `next/font` variables set in `src/app/layout.tsx` — `--font-sans` (10), `--font-display` (17), `--font-mono` (24) — surfaced as utility classes `.font-display` (Georgia serif fallback) and `.font-mono` (JetBrains Mono fallback) in globals.css. Convention: **display serif for headings, mono for labels/eyebrows/metadata.**

**Tailwind is a bare passthrough:** `tailwind.config.ts` has `theme.extend: {}` and no plugins. The design system is NOT in Tailwind — it's the CSS variables plus hand-authored classes in globals.css (`.tile`, `.station-tile`, `.btn`, `.banner`, `.lab`, `.field`, `.pill`, `.crumbs`, `.page`, `.station-cells`, …). A Muster page should use inline styles referencing `var(--…)` + these existing class names, exactly as `StationGrid`/`FacultyStation` do.

---

## FINDING-E19 — The pinned set (referenced by nothing, but must stay)

Ground truth I cross-referenced: `compositions/default/apm.yml` selections (26 Fittings / 11 roles), every seed `apm.yml`'s `provides`/`consumes`/`own_port`/`lifecycle`, `~/.garrison/view-state/eager-boot.json`, and the live `~/.garrison/ui-fittings/*.json`.

**Excluded (they ARE referenced, so not pinned-orphans):** `http-gateway` (consumes orchestrator), the 5 runtimes + `agent-sdk-runtime` (runtime kind, orchestrator policy), `basic-memory` (memory-store), `modes` (consumed by orchestrator), `slack-channel`/`trello`/`google` (channel/connector consumed), `snapshots-default`/`vault-git-sync` (vault/self-consumed).

**The concrete pinned set — must stay although no capability-consumer edge or required slot pulls them in:**

**Tier A — eager, always-on (in `eager-boot.json`, boot with the app, survive `down`, running now):**
- `orchestrator` (7087, own_port) — the policy matrix board UI (the E12 DnD lives here).
- `web-channel-default` (7083, own_port) — the web chat surface the user talks to the Operative through; nothing in-comp consumes `channel`.
- `dev-env` (7086, own_port, operative-bound) — the IDE-replacement surface.
- `kanban-loop` (7089, own_port, operative-bound) — Kanban board + heartbeat loop the `garrison` skill drives; provides automation-runner.

**Tier B — standing automations (`automation-runner`, an `any`/discovery kind — nothing *requires* them, so they'd read as orphans):**
- `automations` (own_port) — the YAML automation engine (automations + scheduler).
- `improver` (own_port) — nightly self-improve loop.
- `scheduler` — cron/scheduled runs.

**Tier C — own-port surfaces that provide/consume NOTHING or a capability no one consumes (graph-invisible, on-demand or detached):**
- `monitor-default` (7077, own_port) — provides `monitor`, **consumed by nobody**. The canonical pinned Fitting the team lead named.
- `screen-share-default` (7079, own_port) — provides `screen-share`, consumed by nobody.
- `browser-default` (7084, own_port) — provides/consumes nothing (the Browser Fitting / garrison-browser surface).
- `ports-default` (own_port) — provides/consumes nothing.
- `power-default` (own_port, **lifecycle: detached** — survives `down`) — provides/consumes nothing.
- `file-browser` (own_port, operative-bound) — provides/consumes nothing (the artifact-store surface).

**Tier D — detached standing infra (not even in the default comp's selections, but running):**
- `coord-agentmail` (own_port, **lifecycle: detached**) — multi-agent mail coordination server; live now (`spawn/coord-agentmail.json`, started 2026-07-11). Nothing requires it; live agent teams depend on it.

**Tier E — content-only, graph-invisible but user-relied:**
- `taste` — provides/consumes nothing; just installs the design skills from E14. Pinned because the user relies on them.

Borderline (technically referenced, keep anyway): `outpost-tailscale-host` (provides `outpost`, consumed by dev-env/vault-sync — but it's the Tailscale host walkthrough/report links depend on) and `deepgram-voice` (own_port connector; voice consumed by web-channel — a Vault-sealed standing connector).

Key files: `~/.garrison/view-state/eager-boot.json` (exactly the 4 Tier-A ids), `~/.garrison/ui-fittings/*.json` (live PIDs), `src/lib/eager-boot.ts` (`setEagerBoot`/`isEagerBoot`), `compositions/default/apm.yml:16-155` (selections).
