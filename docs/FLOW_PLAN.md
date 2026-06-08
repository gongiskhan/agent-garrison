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
| C2-skills | Skills CRUD — `primitive-files.ts` skill writer (create/edit `SKILL.md`/delete-if-loose) + `SkillEditor` (name + `MarkdownEditor`); Skills panel gains New/Edit/Delete beside promote/park | mixed | /quarters/skills | C (serial) | pending |
| C3-scripts | Scripts CRUD — command + rule `.md` create/edit/delete-if-loose (extends `primitive-files.ts`), reuse drawer + `MarkdownEditor`; Scripts panel CRUD | mixed | /quarters/scripts | C (serial) | pending |
| C4-hooks | Hooks CRUD — untagged hand-authored hook write/update/delete helpers (distinct from owner-scoped) + `HookEditor` form; Hooks panel editable for hand-authored groups, fitting-owned stay read-only-with-provenance | mixed | /quarters/hooks | C (serial) | pending |
| C5-plugins | Plugins remove (IF a direct `installed_plugins.json`+dir edit survives Claude Code's manager — verify first, else defer as a logged blocker) + final cross-panel design-audit polish + honesty pass on blurbs/`WRITER_LABEL` | mixed | /quarters/plugins | C (serial) | pending |

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

## Status legend
pending · in_progress · passed · blocked
