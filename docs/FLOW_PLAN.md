# FLOW_PLAN — Garrison as the Config Plane for Claude Code

Authoritative plan of record: `~/.claude/plans/brief-garrison-zippy-sparrow.md`. This file is the build's slice table + resume substrate.

Dev: `npm start` → http://127.0.0.1:7777. Gates: `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` · `npm run test:e2e`.

## Slices

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| S1-settings | Settings surface over `~/.claude/settings.json` (merge-managed, never-clobber) | ui | /settings | A | passed (tests + e2e + flow-video + clean design audit; video not walkthrough-verified) |
| S2-install | Global install/ownership backend + lockfile + skills→`~/.claude/skills/` + adopt | mixed | /armory | A | passed (tests + e2e + flow-video + clean design audit; video not walkthrough-verified) |
| S4-memory | CLAUDE.md editor (user + project); memory-compiler untouched | ui | /memory | A | passed (tests + e2e + flow-video + clean design audit; video not walkthrough-verified) |
| S3-hooks | Hook fittings via the shared writer (owner-scoped tags); delete dead claude-hooks.ts; migrate session-view | mixed | /settings | B | passed (tests + e2e + flow-video + clean design audit; video not walkthrough-verified) |
| S5-importer | `scripts/import-claude-install.ts` — scan `~/.claude` → emit fittings (+`--adopt`) | automation | (cli) | B | passed (tests + validate-fitting PASS; hooks-emission deferred) |

## Parallel groups (disjoint-file reasoning — logged, not silent)
- **Group A (S1, S2, S4):** disjoint owned file sets — S1 owns `settings.*`/`claude-settings-file.ts`; S2 owns `claude-install*.ts`; S4 owns `claude-md.ts` + memory UI. Only shared file is `src/components/chrome/Sidebar.tsx` (S1 + S4 each add one NavLink) → the LEAD serializes those one-line NavLink edits at integration.
  - **Honest execution choice for this run:** S1 and S2 are the keystone libs (the single settings writer + the ownership backend) whose semantics are delicate and consumed by S3/S4. The lead authors them **serially** for correctness; parallel-authoring one delicate ownership contract risks integration churn for little gain. S4 is independent and may be authored in a parallel burst (agent team is enabled).
- **Group B (S3, S5):** run AFTER group A. S3 edits S1+S2 files (shared) → serial w.r.t. them. S5 owns only its script and merely *imports* S2's `adoptFitting` (no edit) → S5 is disjoint from S3 and may run parallel to it.

## Acceptance per slice
- **S1:** `/settings` renders documented keys as typed controls and bespoke keys (`advisorModel`/`autoMode`/…) in an Advanced passthrough; edit→save patches only changed keys; unknown keys byte-preserved; external drift surfaced; unit test proves merge-not-clobber + own-write does not self-report drift. Sidebar shows Settings.
- **S2:** install a skill fitting → files land in `~/.claude/skills/` + lockfile records sha256; uninstall removes exactly those; a pre-existing unowned target is refused (writes nothing); brown-field **adopt** records existing bytes then manages/uninstalls; Armory exposes install/adopt/uninstall + inventory/drift.
- **S4:** `/memory` reads+edits user `~/.claude/CLAUDE.md` and a project CLAUDE.md; never-clobber on external change; `fittings/seed/memory` + compiler untouched.
- **S3:** two hook fittings with different owners coexist; uninstalling one leaves the other + untagged hand-authored groups intact; `src/lib/claude-hooks.ts` + its test deleted; session-view scripts migrated to owner-scoped tags; hooks shown read-only-with-provenance in `/settings`.
- **S5:** run emits N skill + hook fittings, skips existing seeds, each passes `tsx scripts/validate-fitting.ts`; `--adopt` records emitted artifacts at current bytes; no existing seed mutated.

## Quarters-pivot slices (Layer 2 finish — the deferred items from `CLAUDE_CONFIG_PLANE_HANDOFF.md` §6)

The S1–S5 config plane is committed. This second wave finishes the Quarters
pivot's *achievable* deferred items. Engine + read-only Quarters + the roles cut
already shipped (commit `5e640e2`); these slices close the honest, bounded gaps.

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| Q1-docs | RC5 docs sync — correct CLAUDE.md/FACULTIES/CAPABILITIES/METADATA/SPEC/DECISIONS/ROADMAP/FLOW_PLAN to the 6-roles/folded-Operative/Quarters reality; code-derived consistency test | automation (docs) | (docs) | Q-A | passed (tests/docs-consistency 7/7 + typecheck; SPEC §-rewrite + DECISIONS/ROADMAP full sync = RC5 remainder) |
| Q2-logs-sessions | UI6/UI7 — replace placeholder Logs+Sessions note panels with real read-only tailing over the real `~/.claude` (logs/**, daemon.log, sessions/*.json, projects/*/*.jsonl) | ui | /quarters/logs, /quarters/sessions | Q-B | passed (tests 8/8 + e2e 2/2 + typecheck + clean design audit + **verified walkthrough video**; Compose-reframe half deferred) |
| Q3-hook-emission | S5 follow-up — importer/resolver emit installable **hook** fittings (resolver→`hook-group`), not reported-only | mixed | (cli + /armory) | Q-B | passed (tests 5/5 incl. validate-fitting + install round-trip + typecheck; resolves the S5 hook-emission blocker) |
| Q4-ea2 | EA2 follow-ups — `writeFileAtomic` 0600 mode preservation (secret files) + plugins classification (`installed_plugins.json` → `plugin` surface) | mixed | /quarters/plugins | Q-B | passed (tests 7/7 + typecheck + clean design check; plugins surfaced read-only) |

### Parallel groups (disjoint-file reasoning — logged, not silent)
- **Honest execution choice for this wave: serial, lead-authored.** Three forces
  push against parallel authoring here: (1) all code slices share ONE gate
  runtime (a single vitest process + a single sandbox dev-server for e2e/
  walkthrough) which the autothing skill says must serialize; (2) Q3 and Q4 both
  touch the reconcile/primitive-state/claude-scan neighbourhood (hook emission vs
  plugin classification) — not cleanly disjoint, so parallel authoring risks
  integration churn on delicate ownership code; (3) this is a daily-use codebase,
  so correctness > wall-clock. Q1 (docs only) IS fully disjoint and could fan out,
  but cross-doc terminology consistency + one code-derived test favour a single
  author. Group labels (Q-A docs, Q-B code) record the disjoint sets for the
  record; execution is serial Q1→Q2→Q3→Q4.

### Acceptance per slice
- **Q1:** the named docs no longer present the retired model as current (24
  faculties, `soul`/`agent-skill`/`automation-runner`/`data-source`/`mcp-gateway`
  as live kinds, "spawns its own Operative" as present-tense behaviour); a
  committed `tests/docs-consistency.test.ts` reads the role set + capability-kind
  enum from `src/lib` source and asserts the docs agree (catches future drift).
- **Q2:** `/quarters/logs` and `/quarters/sessions` render real read-only content
  tailed from the sandbox `~/.claude`; path-traversal guarded; routed through the
  `claude-home.ts` seam (never live `~/.claude` in tests); vitest + e2e green; a
  walkthrough video (sandbox dev-server, read-only-safe).
- **Q3:** the importer emits an installable hook fitting from an untagged
  settings.json hook group; it passes `validate-fitting`; installing it writes the
  owner-scoped `_garrison: "fitting:<id>"` group through the shared writer.
- **Q4:** `writeFileAtomic` preserves an existing 0600 file's mode (no perm
  widening); the Quarters Plugins surface lists plugins parsed from
  `installed_plugins.json`. Vitest proves both.

### Deferred (explicitly logged, NOT silently dropped) — see `docs/autothing/decisions.md`
- **RC4 (full)** — hosted authoring (`hosted-authoring.ts`, `scoped-reconcile.ts`)
  + the **Run → hosted-session launcher**. Deferred *whole*: wiring orchestrator
  projection into the live `up()` while it still spawns a process is a half-
  migration (instructions delivered twice into a process the pivot is retiring) —
  worse than today's honest "it genuinely spawns". `runner.ts` is untouched this
  wave.
- **Compose reframe** (part of UI6/UI7) — reframing `/compose` as the role-fitting
  editor for the global composition. Large; deferred.
- **garrison-control MCP** — gated on **SP1** (APM MCP write-through), unverified.
  Not built blind.
- **EA5** — retire the S2 own-installer (`claude-install.ts`) as a strangler.
  Risky deletion of a working installer in an unattended run; deferred.

## Quarters-CRUD wave (manage everything from the UI)

The Quarters surface shipped **read + promote/park/unpark only** — no
create/edit/delete on any primitive. This wave makes Quarters a real manager:
add an MCP, edit a hook, author a skill, delete a command, all from the UI, plus
a reusable editor-component shell so each surface gets richer affordances in the
existing shell visual language (no redesign).

### The writer-of-record invariant (governs every panel's available actions)

> **Garrison's UI freely CRUDs only what it is writer-of-record for** — loose
> on-disk files, hand-authored/untagged hooks, and `mcp.json`. For anything
> another writer owns — the APM lock (owned files), a fitting (`_garrison`-tagged
> hooks), or Claude Code's plugin manager (plugins) — the UI routes mutations
> through that owner's mechanism (promote/park/unpark; fitting install/uninstall)
> or stays read-only. **Never write behind the owner's back.**

Action matrix that falls out of the invariant:
- **Create** → always lands loose (no owner conflict) → allowed on every writable surface.
- **Edit content** → loose: plain write. Owned file: allowed but warned ("APM-managed; editing creates lock drift" — drift is already modeled + surfaced). Fitting-owned hook: read-only.
- **Delete** → loose: remove. Owned file: **blocked — route to Park** (deleting behind the lock makes the lock lie). Fitting-owned hook: read-only.

CRUD does NOT reuse `TransitionResult` (its `deployed/cleanedOrphans` shape is
promote/park-specific); a parallel `CrudResult` widens the `/api/quarters`
dispatch. A new `GET /api/quarters/primitive?id=` returns one primitive's detail
(file content, mcp config, hook detail) for the editors.

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| C1-mcp | MCP CRUD — `mcp-writer.ts` (add/update/remove, wrapper-shape + both transports preserved) + reusable `QuartersDrawer`/`ConfirmDialog` shell + MCP transport form + detail endpoint; MCPs panel gains Add/Edit/Remove | mixed | /quarters/mcps | C (serial) | passed (unit 13/13 + suite 406✓ + e2e round-trip + typecheck/lint/build 0 + clean design audit; per-slice video deferred to consolidated walkthrough) |
| C2-skills | Skills CRUD — `primitive-files.ts` skill writer (create/edit `SKILL.md`/delete-if-loose) + `SkillEditor` (name + `MarkdownEditor`); Skills panel gains New/Edit/Delete beside promote/park | mixed | /quarters/skills | C (serial) | passed (unit 6/6 incl. owned-delete guard + e2e create/edit/delete + typecheck/lint 0 + clean design audit; video deferred) |
| C3-scripts | Scripts CRUD — command + rule `.md` create/edit/delete-if-loose (extends `primitive-files.ts`), reuse drawer + `MarkdownEditor`; Scripts panel CRUD | mixed | /quarters/scripts | C (serial) | passed (e2e command round-trip + 2 surfaces listed + typecheck/lint 0 + clean design audit; reuses C2 writer; video deferred) |
| C4-hooks | Hooks CRUD — untagged hand-authored hook write/update/delete helpers (distinct from owner-scoped) + `HookEditor` form; Hooks panel editable for hand-authored groups, fitting-owned stay read-only-with-provenance | mixed | /quarters/hooks | C (serial) | passed (unit 7/7 incl. owned-refusal + e2e editable/read-only + create/edit/delete + typecheck/lint 0 + clean design audit; video deferred) |
| C5-plugins | Plugins remove (verified safe: `installed_plugins.json` is the source of truth) + final cross-panel design-audit + honesty pass on blurbs | mixed | /quarters/plugins | C (serial) | passed (unit 4/4 incl. path-guard + full suite 423✓/build/e2e 9✓ + clean design audit; plugin INSTALL deferred to /plugin; video deferred) |

### Parallel groups (disjoint-file reasoning — logged, not silent)
- **Group C: serial, lead-authored.** Same three forces as the Q-wave: (1) one
  shared gate runtime (single vitest + single sandbox dev-server) the autothing
  skill says must serialize; (2) every slice integrates into the SAME two shared
  files — `PrimitiveListPanel.tsx` (the parameterized panel) and the
  `/api/quarters` dispatch (`quarters.ts`) — so parallel authoring would collide;
  (3) C1 establishes the reusable drawer/confirm shell + `CrudResult` contract
  that C2–C5 inherit, so C1 must land first. Writer libs (`mcp-writer.ts`,
  `primitive-files.ts`, hook helpers, plugin remove) ARE disjoint and are noted
  for the record, but the integration seam forces serial. Execution: C1→C2→C3→C4→C5.

### Acceptance per slice
- **C1:** `/quarters/mcps` has an **Add server** button opening a transport form (stdio: command/args/env; http/sse: url/headers); each row has **Edit** + **Remove**; writes go through `mcp-writer.ts` which preserves the file's wrapper shape and round-trips both transports; removing the seeded `sandbox-mcp` deletes it from `mcp.json`; the reusable `QuartersDrawer` + `ConfirmDialog` render in the shell language (no emoji). Vitest proves add/update/remove + shape preservation; e2e proves a create→assert→remove round-trip with a unique fixture name.
- **C2:** Skills panel has **New skill** (name + `SKILL.md` body) → lands a loose `skills/<name>/SKILL.md`; **Edit** opens the markdown body; **Delete** removes a loose skill, and is **blocked with a Park hint** for an owned skill. Vitest proves create/edit/delete + the owned-delete guard; e2e round-trips a unique skill.
- **C3:** Scripts panel CRUDs command + rule `.md` files (create/edit/delete-if-loose, owned-delete → Park hint), reusing the drawer + `MarkdownEditor`. Vitest + e2e round-trip.
- **C4:** Hooks panel shows hand-authored (untagged) groups as **editable** (add event+matcher+command, edit, delete) and fitting-owned (`_garrison`) groups as **read-only with provenance**; new helpers write/delete by event+index WITHOUT a `_garrison` tag (never misclassify a user hook as fitting-owned). Vitest proves untagged round-trip + that fitting-owned groups are untouched; e2e adds + removes a hand-authored hook.
- **C5:** EITHER a working plugin remove (verified to survive Claude Code's manager) with confirm, OR a logged blocker if direct edit is unsafe; plus a final design audit across all new components and a metadata-honesty pass (blurbs/`WRITER_LABEL` no longer claim "read-only"/"manage via fitting" where CRUD now exists).

## S1b wave — Settings: full settings.json coverage with proper editors

S1 shipped 18 hand-picked keys with raw-JSON textareas for anything complex.
This wave manages **every key of the official schema** (82 top-level keys,
vendored at `src/lib/claude-settings-schema.json`, synced by a mechanical test
gate) with per-type editors: enum selects, list editors, key→value editors,
structured object sub-forms, validated permission-rule rows. VS Code-style
layout (sticky group nav + live search). User scope only. All S1 invariants
preserved: single-writer merge, per-key autosave patches, drift baseline +
echo suppression, bespoke passthrough, no save button. `hooks` stays read-only
here (CRUD lives in Quarters → Hooks, C4).

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| S1b-settings-complete | Full 82-key settings.json coverage: schema-synced catalog + typed editors + searchable group layout | ui | /quarters/settings (+ /settings) | S1b (serial) | passed (tests 456✓ incl. 29 new + e2e 30✓ all 3 viewports + typecheck/lint/build 0 + clean design audit + **verified walkthrough video**) |

### Parallel groups (disjoint-file reasoning — logged, not silent)
- **S1b: serial, lead-authored.** Single slice; every editor component funnels
  into the same two integration files (`SettingsPanel.tsx` and
  `settings-catalog.ts`) and the same gate runtime (one vitest + one sandbox
  dev-server), so there is nothing disjoint to fan out. Resumed from a prior
  session's durable state (catalog + vendored schema + sync gate already
  green; validators/editors/panel/e2e authored this session).

### Acceptance
- **S1b:** catalog ∪ {hooks} === schema.properties − {$schema} both directions,
  enforced by `tests/settings-catalog.test.ts` (enum/bounds/managed-only/
  deprecated/pattern sync); every key renders a per-type editor (object-forms
  spread-preserve unrecognized subkeys; permission rules parse into tool +
  specifier rows, legacy rows never silently rewritten); search filters rows +
  match count; managed-only keys sit in a collapsed Enterprise group with an
  honest banner; per-key autosave patches only the touched top-level key
  (proven: whole-sandbox patch preserves sibling bespoke keys); schema-dropped
  keys (editorMode, autoScrollEnabled) fall to the Advanced passthrough with
  zero data loss; e2e proves search, structured permission-rule add, sandbox
  toggle, enterprise collapse, hooks link, no save button, zero console errors.

## W wave — Workspaces Fitting, view-state persistence & run-panel eager boot

Brief: universal automatic persistence of every view's state across server
restarts; run-panel toggles that eager-boot chosen views; a **Workspaces**
Fitting that tiles referenced view instances into resizable panes. Three
layers: (1) stable per-instance identity, (2) a generic `(fitting, instanceId)`
state store at `~/.garrison/view-state/`, (3) eager activation toggles.
Workspaces composes, never owns — its persisted state is just a
`(instanceRef, geometry)` layout. Confirmed decisions: **D1** terminal v1 =
respawn shell with restored cwd + scrollback (PTY dies; herdr deferred);
**D2** toggle per view type; **D3** `~/.garrison/view-state/<fittingId>/
<instanceId>.json` via `writeJsonAtomic`, debounced ~500ms, no save buttons
anywhere. E1 resolution: parser **derives** a synthetic `view` capability from
`ui.views[]`/`own_port` (no per-fitting manifest churn); Workspaces consumes
`view` with cardinality `any`.

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| W1-instance-identity | Stable view-instance IDs + derived `view` capability kind (`view-instances.ts`, metadata derivation, capabilities) | automation | (lib) | W-serial | passed (tests 15/15 + full gates; prompt no-pollution asserted) |
| W2-view-state | Generic view-state store (`view-state.ts`, `/api/view-state`, `usePersistedViewState`) + terminal cwd/scrollback proof | mixed | (lib + terminal fitting) | W-serial (after W1) | passed (PERSIST_OK + NO_SAVE_BUTTON_OK + live restart proof, same session id) |
| W3-eager-boot | Run-panel per-view-type toggles + server-start eager boot (`src/instrumentation.ts`, `eager-boot.json`) | mixed | /run | W-A (after W2) | passed (EAGER_BOOT_OK + LAZY_RESTORE_OK; real npm-start boot verified; webpack/instrumentation landmine fixed via detached tsx runner) |
| W4-workspaces | Workspaces Fitting — tiling resizable panes over referenced instances, layout persisted via Layer 2, top-of-menu Workspace/Garrison switch, chrome ≤28px | ui | /fitting/workspaces | W-A (after W2) | passed (WORKSPACE_LAYOUT_OK + WORKSPACE_PANES_OK + CHROME_OK 24; validate-fitting PASS; full-bleed chrome landed from design audit) |

### Parallel groups (disjoint-file reasoning — logged, not silent)
- **W-serial (W1→W2):** W2's store keys on W1's instance IDs and both touch
  `types.ts`/`metadata.ts` neighbourhood — serial by dependency.
- **Group W-A (W3, W4):** disjoint owned sets — W3 owns `instrumentation.ts`,
  `eager-boot` lib/API, `RunPanel.tsx`; W4 owns `fittings/seed/workspaces/`,
  its registry entry, and the Sidebar top-of-menu switch. No shared edit
  files → **author in parallel** (ultracode is on; workflow/teammates with
  explicit file-ownership boundaries), but the gate runtime (one vitest + one
  sandbox dev-server + one recorder) serializes — gates run lead-sequenced
  W3 then W4.

### Acceptance per slice (sentinels lifted verbatim from the brief)
- **W1:** every produced view is addressable as `(fittingId, viewId,
  instanceId)`; single-instance views default `instanceId: "default"` and all
  existing routes/tests still pass; the resolver exposes the derived `view`
  capability and a consumer with cardinality `any` discovers instances without
  hardcoding. Vitest proves derivation + backward compat.
- **W2:** real on-disk round-trip — create instance, write known state,
  re-init the persistence layer (simulated restart), read back exact match →
  print `PERSIST_OK <instanceId>`; state survives with no explicit save call →
  print `NO_SAVE_BUTTON_OK`; terminal fitting round-trips cwd + scrollback per
  D1.
- **W3:** toggle on → boot sequence → persisted instance active → print
  `EAGER_BOOT_OK <view>`; toggle off → not auto-active but state restores on
  open → print `LAZY_RESTORE_OK <view>`.
- **W4:** layout with 2 referenced instances + geometry persists and reloads
  with refs+geometry matching → print `WORKSPACE_LAYOUT_OK`; Playwright opens a
  workspace, asserts N panes render referenced view types, resizes a pane and
  asserts geometry changed, saves a screenshot and prints its path → print
  `WORKSPACE_PANES_OK`; pane title-bar height ≤ 28px → print `CHROME_OK <px>`.

## DE wave — Dev Env consolidation (2026-06-11)

One slice: the three retired session surfaces collapse into a single own-port
**dev-env** Fitting on :7086 (Claude PTY + shell PTY + browser pane per
hook-detected Claude Code session); the workspaces Fitting is deleted outright
with no successor. dev-env takes over `~/.garrison/sessions/state.json` and the
4 owner-tagged Claude Code hook groups; http-gateway's worktrees passthrough
now defaults to :7086.

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| DE1-dev-env | Dev Env consolidation — terminal + worktrees + session-view collapse into the dev-env fitting; workspaces deleted | ui (own-port fitting) | (own-port :7086) | DE-serial | done (2026-06-11) |

### Acceptance
- **DE1:** `tsx scripts/validate-fitting.ts fittings/seed/dev-env` passes all
  four checks; `npm run typecheck` clean; vitest green including
  `tests/dev-env.test.ts` + `tests/dev-env-hooks-install.test.ts`; the
  http-gateway `/worktrees` passthrough round-trips (GET/POST `/worktrees`,
  DELETE `/worktrees/:id`) against dev-env on :7086.

## MR wave — Model Router (Orchestrator) + Improver (BRIEF v2, 2026-06-13)

Plan of record: `~/.claude/plans/brief-v2-model-swift-neumann.md` (brief §2/§3
verbatim + substrate-delta adaptations); ground truth:
`EXPLORATION_REPORT_router_improver.md`. The brief predates the PTY-everywhere
commits (`1fdd49f`/`c562ac9`): the warm-pool class, the `gateway-legacy.mjs`
deletion, and the `spawnClaude`/`spawn-soul.mjs` PTY migration already shipped,
so **P0 wires + finishes** the substrate rather than rebuilding it. Two-stage
routing (gateway pre-route → act), Profile-based policy (Exceptions → Matrix →
Continuations + per-route discipline), a compiled `{{routing}}` section in the
orchestrator prompt, own-port view + simulator (:7087), three provider skills,
a nightly Improver + review queue (:7088), a Workflows Quarters category.
Sentinel tokens are lifted verbatim from brief §3.

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| MR0a-purge | Programmatic-path purge finish — delete `scripts/spike` + vestigial dogfood `gateway-legacy.mjs` + tidy comments; committed banned-pattern guard test | automation | (lib/scripts) | MR0 (parallel) | passed (guard 2/2 + full suite 500✓ + typecheck/lint/build 0; backend slice, no video — `programmatic-purge-ok`) |
| MR0b-kind-scheduler | Re-add `automation-runner` capability kind (data-source precedent) + repair scheduler manifest to the 6-roles schema; scheduler selectable + `--probe` ok | mixed | (lib + scheduler fitting) | MR0 (parallel) | passed (unit 3/3 + suite 506✓ + validate-fitting PASS + scheduler --probe ok + typecheck/lint/build 0; ecosystem re-homed observability/sessions; personal-operative stays parked — `scheduler-manifest-ok`) |
| MR0c-reconcile-wire | Wire `reconcile("post-authoring")` into quarters `file.*` actions + test | mixed | (lib) | MR0 (parallel) | passed (unit 3/3 + suite 506✓ + typecheck/lint/build 0; best-effort scoped reconcile after file.* success — `reconcile-wired-ok`) |
| MR0e-probes | Empirical model/effort-switch probe (slash-inject vs respawn) + JSONL persistence probe (live pty operative turns) | automation | (claude-pty + gateway) | MR0 (serial) | passed (live probes: slash-inject-verdict=works [Sonnet→Haiku via injected /model], jsonl-verdict=absent [no transcript written]; committed probe scripts) |
| MR0d-pool-wire | Warm pool primitive proofs — pool-rotate test (existing) + measured idle cost (352 MB/0 tokens) + classify-through-pool (~6s/turn). Gateway integration (pinned classifier + Profile-derived plan) deferred to MR1 (needs the Profile). **Verdict=works → ONE generic pool + /model+/effort inject at checkout.** | mixed | (gateway + claude-pty) | MR0 (serial, after MR0e) | passed (pool-rotate 1/1 + pool-cost-measured 0 tokens/352 MB + sim-session-ok ~6s/turn; committed probes) |
| MR1a-config-compiler | `routing.json` **v4** schema (roles → profile roleMap → target, shared matrix) + seed 3 Profiles (balanced/economy/premium) + pure byte-stable compiler (`--check`) + resolver core | mixed | (router fitting) | MR1 (serial, after MR0) | passed (vitest 13/13 + compile --check balanced/economy byte-stable + probe ok + validate-fitting PASS + typecheck/lint/build 0; v4 role-layer adaptation recorded — `routing-compile-ok` `profiles-compile-ok` `continuations-compile-ok`) |
| MR1b-assembly | `{{routing}}` placeholder in `assembleSystemPrompt` + projection; model-router ships the v4 orchestrator prompt preserving `[orchestrator-active]` + `{{capabilities}}`; integration-check passes | mixed | (runner + router fitting) | MR1 (serial) | passed (routing-assembly 6/6 + full suite 525✓ + integration-check router-v4/default PASS + validate-fitting PASS + typecheck/lint/build 0; runtime dynamic-import, default composition untouched — `assembly-ok`) |
| MR1c-stageA | Stage A classify (warm classifier prompt + response parser) → pure-code resolve (exceptions → cell → inheritance → default → role → roleMap → target); fixtures + resolution unit tests | mixed | (gateway lib) | MR1 (serial) | passed (routing-classify 9/9 + routing-compiler 13/13 + live classify probe 3/3 valid + full suite 534✓ + typecheck/lint/build 0 — `classify-ok` `resolve-ok` `rolemap-ok`) |
| MR1d-stageB | Stage B native model/effort switch (slash-inject) + provider/soul respawn-with-continue + multi-provider launch env | mixed | (gateway + claude-pty) | MR1 (serial) | passed (stage-b 12/12 + full suite 546✓ + MR0e live slash-inject + provider-launch env asserted + typecheck/lint/build 0; soul-switch mechanism-proven, live ephemeral probe inconclusive [upstream --continue persistence, logged] — `model-switch-ok` `provider-launch-ok` `soul-switch-ok`) |
| MR1e-telemetry | `decisions.jsonl` at resolution time + reply `[route:]` token honored diff-check | mixed | (gateway) | MR1 (serial) | passed (telemetry 10/10 + live full-path probe decisions-log-ok + route-token-ok honored=true + full suite 556✓ + typecheck/lint/build 0 — `decisions-log-ok` `route-token-ok`) |
| MR2-view | Own-port Model Router view (Policy/Simulator/Compiled/Telemetry panes) on :7087 owning `GET/PUT /routing`; discipline + continuations editing; Profile switch + pending-restart banner; simulator + pins; walkthrough video | ui (own-port :7087) | (own-port) | MR2 (serial, after MR1) | passed (server 8/8 + 3-viewport e2e + validate-fitting PASS + typecheck/lint/build 0 + clean design audit; `router-view-ok` `discipline-ok` `continuations-ok` `profiles-ok` `simulator-ok` `simulator-pins-ok`; walkthrough-video DEFERRED to consolidated MR-wave film [logged]) |
| MR3-provider-skills | `provider-skills` fitting shipping gemini-cli/gemini-api/codex-cli (`.apm/skills`); stdin/temp-file spec, model allowlist, loud missing-key, artifact write, schema-validated summary, delegation log; `--probe` | mixed | (fitting + skills) | MR3 (after MR1, ∥ MR4) | pending |
| MR4-workflows-quarters | New read-only Workflows Quarters category (`.claude/workflows` + `~/.claude/workflows`; empty-state-first; fixture-tested); workflows appear as router `workflow` targets | mixed | /quarters/workflows | MR4 (after MR1, ∥ MR3) | passed (workflows-scan 5/5 + full suite 601✓ + typecheck/lint/build 0 — `quarters-workflows-ok` `workflow-target-ok`; visible panel deferred as thin read-only follow-up [logged]) |
| MR5a-improver | Nightly Improver runner + memory-consolidation rule (proposal diff + queue) + own-port review queue (:7088) applying via hosted APIs + reconcile; vault-locked/server-down skip | mixed | (fitting + own-port :7088) | MR5 (after MR0+MR1+MR3) | passed (improver 11/11 + scheduler list shows the job + --probe ok + validate-fitting PASS + full suite 612✓ + typecheck/lint/build 0 — `improver-proposal-ok` `improver-skip-ok` `improver-scheduled-ok`; live review-queue UI apply [improver-apply/reject/conflict] deferred [logged]) |
| MR5b-autonomy | Autonomy promotion/demotion lifecycle (streaks; manual default; instant demotion); park tier-classifier fitting | mixed | (improver fitting) | MR5 (serial, after MR5a) | passed (autonomy state machine tests + tier-classifier PARKED [parked:true + structurally unselectable] — `autonomy-promotion-ok` `autonomy-demotion-ok` `classifier-parked-ok`) |

### BRIEF v4 reframe (2026-06-14) — roles/profiles + Runtime & Knowledge faculties

The MR wave was authored against BRIEF v2 (matrix→target router + provider
*skills*). BRIEF v4 is a ground-up reframe that the in-flight MR slices fold
into, adapting mechanism while preserving intent (recorded per slice). The three
v4 deltas over the v2 plan:

1. **Roles layer (folded into MR1).** The matrix + exceptions resolve to a
   fixed-vocabulary **role** (`expert|standard|fast|image|video|review`), shared
   across Profiles; a Profile is just its `roleMap` (role→target) +
   `disciplineOverrides`. Landed in **MR1a** (config + compiler + resolver).
   MR1b–e, MR2 inherit it unchanged in shape.
2. **Runtime Faculty (NEW, replaces MR3-provider-skills).** There are **no
   capability skills** — every model/capability is a **runtime**. A shared
   `RuntimeAdapter` contract + generic pool + generic runtime-bridge MCP, with
   THREE adapters: Claude Code (primary, multi-provider: anthropic-plan /
   ollama-local / one cloud-OSS), **Codex** (proven secondary), **Gemini-CLI**
   (capability secondary incl. image — may ship contract-stubbed). Targets gain
   `secondary:<runtime>`. Multi-provider launch env (ANTHROPIC_BASE_URL + vault
   key) per pooled session.
3. **Knowledge Faculty (NEW).** A composite fitting consuming `memory-vault` +
   **CodeGraph** + **Serena** (+ optional doc-index); owns the canonical vault;
   emits CLAUDE.md/AGENTS.md/GEMINI.md projections; wires the shared MCPs into
   every runtime session; idempotent provisioning + harvest. This is the
   portability lever (memory survives a runtime/provider switch).

New v4 slices appended after the v2 MR slices below:

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| MRr-adapter | `RuntimeAdapter` contract + conformance harness (spawn→awaitReady→sendTurn→awaitResponse→teardown) over the existing claude-pty driver | mixed | (packages/runtime) | MRr (after MR1) | passed (runtime-adapter 4/4 + ClaudeCodeAdapter reference + typecheck/lint/build 0 — `adapter-contract-ok`) |
| MRr-pool-multi | Generic pool warms primary + each active secondary; multi-provider launch env (anthropic-plan + ollama-local) asserted per-process | mixed | (gateway + claude-pty) | MRr (after adapter) | passed (multi-runtime-pool 3/3 + full suite 596✓ + typecheck/lint/build 0; multi-provider launch env asserted in MR1d's stage-b tests — `multi-runtime-pool-ok`) |
| MRr-bridge | Generic runtime-bridge MCP `delegate(task_spec)->{summary,artifacts}` (stdin/temp spec, allowlist, artifact write, schema-validated return, delegation log) | mixed | (fitting + mcp) | MRr (after pool) | passed (runtime-bridge 6/6 + codex bridge --probe ok + typecheck/lint/build 0 — `runtime-bridge-ok`) |
| MRr-codex | Codex runtime adapter (full secondary) + Quarters-Codex base; primary→secondary coding delegation | mixed | (codex fitting) | MRr (after bridge) | passed (codex-runtime 9/9 + validate-fitting PASS + runtime kind added + full suite 580✓ + typecheck/lint/build 0; `secondary-delegate-ok` `runtime-bridge-ok`, mix-and-match contract-level [pool-wiring deferred]) |
| MRr-gemini | Gemini-CLI runtime adapter (capability secondary, image) + Quarters-Gemini base; primary→secondary image delegation (may be contract-stubbed) | mixed | (gemini fitting) | MRr (after bridge, ∥ codex) | passed (gemini-runtime 5/5 + validate-fitting PASS + --probe ok + full suite 585✓ + typecheck/lint/build 0 — `gemini-runtime-ok`) |
| MRk-knowledge | Composite Knowledge fitting + memory-vault sub-fitting + projections (CLAUDE.md/AGENTS.md/GEMINI.md) + idempotent provisioning/harvest | mixed | (knowledge fitting) | MRk (after MRr) | passed (knowledge 8/8 + both probes ok + validate-fitting PASS + full suite 593✓ + typecheck/lint/build 0 — `knowledge-probe-ok` `projection-ok` `provisioning-idempotent-ok` `harvest-idempotent-ok`) |
| MRk-codegraph | CodeGraph sub-fitting (install + wire MCP; index fixture repo, answer a query) | mixed | (sub-fitting) | MRk (∥ serena) | blocked (codegraph CLI not installed; provisioning WIRES `codegraph mcp` into .mcp.json — live query-answer deferred to install. Honest blocker, logged) |
| MRk-serena | Serena sub-fitting (install + wire MCP; symbol-nav query) | mixed | (sub-fitting) | MRk (∥ codegraph) | blocked (serena not installed [uvx present]; provisioning WIRES `serena start-mcp-server` into .mcp.json — live symbol-nav query deferred to install. Honest blocker, logged) |
| MRk-mcp-wire | Spawned runtime session MCP config lists Knowledge/CodeGraph/Serena endpoints | mixed | (runner) | MRk (after sub-fittings) | passed (provisioning writes .mcp.json listing knowledge/codegraph/serena, idempotent — proven by knowledge-faculty test; a live spawned-session handshake folds into runner MCP wiring) |

These are sequenced by the dynamic build loop after the v2 MR1/MR2 line lands
(the router config/compiler/view is the spine the runtimes + knowledge plug
into). `data/library.json` registry wiring for model-router + the orchestrator
faculty swap (model-router replaces garrison-orchestrator as the orchestrator
provider) is MR1b integration work.

### Parallel groups (disjoint-file reasoning — logged, not silent)
- **MR0 (parallel where disjoint):** MR0a (delete spike + comments + one new test
  file), MR0b (`src/lib/types.ts` enum + scheduler/consumer `apm.yml`s), MR0c
  (`src/lib/reconcile.ts` + `quarters.ts` dispatch) own disjoint file sets → fan
  out. MR0e (live-session probes) gates MR0d — the probe verdict picks the pool
  shape (generic + slash-inject vs per-combo respawn) — and both touch the
  gateway/claude-pty against ONE shared runtime, so MR0e→MR0d serialize.
- **MR1 (serial):** routing config → compiler → assembly → Stage A → Stage B →
  telemetry is a dependency line through the gateway + runner on one gate runtime.
- **MR2 serial after MR1** (the view renders the compiled prompt + drives `PUT /routing`).
- **MR3 ∥ MR4 after MR1:** disjoint file sets (provider-skills fitting vs the
  Quarters category files); the e2e/video pass serializes on the shared runtime.
- **MR5 after MR0+MR1+MR3:** the Improver consumes `automation-runner` (MR0b),
  the router's `PUT /routing` (MR1), the artifact store, and applies via hosted
  APIs; serial MR5a→MR5b.

### Acceptance per slice (sentinel tokens lifted verbatim from brief §3)
- **MR0a:** banned-pattern grep clean outside docs/tests-of-the-ban; committed guard test green → `programmatic-purge-ok`.
- **MR0b:** scheduler selectable + `--probe` ok; the 6 `automation-runner` consumers parse → `scheduler-manifest-ok`.
- **MR0c:** `reconcile("post-authoring")` fires from quarters `file.*` + test → `reconcile-wired-ok`.
- **MR0d:** size-2 pool, checkout triggers background replacement, two concurrent checkouts distinct → `pool-rotate-ok`; measured idle cost → `pool-cost-measured: <tokens> tokens, <MB> MB`; two pooled classifier turns, no respawn → `sim-session-ok`.
- **MR0e:** `/model`+`/effort` inject probe → `slash-inject-verdict: works|respawn-fallback`; transcript probe → `jsonl-verdict: persists|absent`.
- **MR1a:** compiler `--check` → `routing-compile-ok`; balanced marker present; economy byte-stable-different → `profiles-compile-ok`; the 2 seeded continuations rendered → `continuations-compile-ok`.
- **MR1b:** assembled prompt has routing section AND `[orchestrator-active]`; integration-check passes → `assembly-ok`.
- **MR1c:** classifier `{taskType,tier}` JSON on 3 fixtures → `classify-ok`; resolution unit tests (exception/cell/inheritance/default) → `resolve-ok`.
- **MR1d:** different `{model,effort}` lands on the target model → `model-switch-ok`; a soul route respawns-with-resume, context preserved → `soul-switch-ok`.
- **MR1e:** gateway logs the decision → `decisions-log-ok`; reply ends with a matching `[route:` token → `route-token-ok`.
- **MR2:** matrix-cell edit → compiled pane updates → `PUT /routing` (sandboxed) → `router-view-ok` (+ screenshot path); T2 discipline edit renders → `discipline-ok`; continuation card renders → `continuations-ok`; Profile switch + pending-restart banner → `profiles-ok`; simulator one-shot → `simulator-ok`; pins green + one red → `simulator-pins-ok`; storyboard walkthrough → `walkthrough-video-ok`.
- **MR3:** each skill `--probe` ok; mocked-provider contract test (stdin spec, allowlist, loud missing-key, artifact, schema-validated summary, delegation log) → `delegation-contract-ok` ×3.
- **MR4:** fixture workflow listed + empty-state → `quarters-workflows-ok`; appears in router dropdown → `workflow-target-ok`.
- **MR5a:** `run-now improver-nightly` ≥1 memory-consolidation proposal → `improver-proposal-ok`; Approve→applied via hosted API→reconcile → `improver-apply-ok`; Reject untouched → `improver-reject-ok`; 409 path → `improver-conflict-ok`; scheduler `list` shows the job → `improver-scheduled-ok`; vault-locked skip → `improver-skip-ok`.
- **MR5b:** seeded streak → promotion proposal → Approve sets auto → `autonomy-promotion-ok`; reject an auto-applied change → demote to manual + notice → `autonomy-demotion-ok`; tier-classifier parked, unreferenced → `classifier-parked-ok`.
- **MR6 (final):** all gates green; evidence-index upserted; FLOW_PLAN updated; print every token once then `MODEL-ROUTER-IMPROVER-COMPLETE`.

## Status legend
pending · in_progress · passed · blocked

---

## U-wave — BRIEF v4 Completion (make it live + verify the asserted paths) — PASSED 2026-06-15

Finishes the v4 items left blocked/deferred/asserted. `codegraph`/`serena` now
installed. globalGate `passed`; buildable-remaining 0. Full suite 635 passed / 0
failed; typecheck/lint/build exit 0.

| id | title | status | tokens |
|----|-------|--------|--------|
| U1 | Live gateway Stage-A routing + MultiRuntimePool (PRIMARY) | passed | `live-route-ok` `live-switch-ok` |
| U2 | codegraph + serena answer LIVE through the wired MCP | passed | `codegraph-ok` `serena-ok` `provisioning-idempotent-ok` |
| U3 | Improver review-queue own-port view + live apply/reject/409 + autonomy | passed | `improver-proposal-ok` `improver-apply-ok` `improver-reject-ok` `improver-conflict-ok` `autonomy-direct-ok` `autonomy-promotion-ok` `autonomy-demotion-ok` |
| U4 | Live Codex/Gemini/ollama round-trips + soul-switch carryover | passed | `secondary-delegate-live-ok` `gemini-runtime-live-ok` `provider-launch-live-ok` `soul-switch-ok` |
| U5 | U-wave evidence walkthrough | passed | `videos-verified-ok` |
| U6 | Commit + final | passed | `GARRISON-V2-COMPLETE` |

### What shipped (live, not asserted)
- **U1** `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs` (RoutedGateway: classify→resolve→log→planSwitch→honored, MultiRuntimePool-served) wired into `gateway-pty.mjs` (`initRouting`/`runRoutedTurn`, `GARRISON_ROUTING`, stub seam `GARRISON_GATEWAY_RUNTIME_STUB`). Committed gates + a real-claude probe (`scripts/probe-live-gateway.mjs`).
- **U2** corrected the MCP wiring (`codegraph serve --mcp`, `serena start-mcp-server --context ide-assistant`); `scripts/lib/mcp-stdio-client.mjs` drives the real servers; `tests/knowledge-mcp-live.test.ts` (`GARRISON_LIVE_TOOLS=1`).
- **U3** `improver/lib/apply-core.mjs` (never-clobber baselineSha → 409 → re-read+re-diff) + `review-queue.mjs` + own-port `scripts/server.mjs` (:7088) + `ui/` review view; real `reconcile('post-authoring')` runs.
- **U4** real round-trips, each with a CLI/runtime self-unblock: codex `--skip-git-repo-check`, gemini `--skip-trust`, `session.mjs` `providerLaunch` (preserve `ANTHROPIC_BASE_URL` so ollama is reached), and the soul-switch carryover fallback (`buildContextCarryover`). `tests/third-party-live.test.ts` (`GARRISON_LIVE_THIRDPARTY=1`).
- **U5** `scripts/walkthrough-u-wave.sh` → `docs/autothing/evidence/u-wave-walkthrough.{cast,gif}` (all U-wave committed gates green).

### Environment note (non-blocking)
Late in the run the dev machine hit a transient load >300 (the user's Chrome +
I/O + a stuck codegraph MCP daemon its own watchdog kills), under which the
interactive `claude` TUI submit window flaked for RE-runs of the claude-PTY
probes. Not a logic regression — the deterministic committed gates are green and
the live tokens were captured when load was normal. Heavy live round-trips are
gated behind env flags so the normal suite stays deterministic.
