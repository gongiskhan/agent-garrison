# FLOW_PLAN — promote primitives to first-class Fittings + editable setup instructions

Run: `20260624-214443-357bf40f` · Branch: `main` · Project: agent-garrison
Decisions (confirmed): Hybrid scope · 7 purpose-named optional faculties · modes-anchored Agent/Dev (lean Agent).
Full design: `/FITTINGS_MIGRATION_PLAN.md`.

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| s1 | `x-garrison.setup` accepts an ordered array of steps (back-compat single step) | backend | — | A | pending |
| s2 | Faculty `tier: agent\|dev` + 7 new optional faculties | backend | — | A | pending |
| s3 | Promoted-primitives catalog (authored descriptor sidecar) + API, joined to live Quarters discovery | mixed | /api/promoted-fittings | A | pending |
| s4 | Compose: Agent/Dev faculty headers; promoted fittings replace "Claude Code components" group | ui | /compose | B | pending |
| s5 | Setup Instructions editor on fitting detail (visible, inline, add/edit/remove/reorder, autosave) | ui | /fitting/<id> | B | pending |
| s6 | Vocabulary sweep + real seed package setup-steps (coord-mcp) exercising the hybrid path | backend | — | C | pending |

## Acceptance per slice
- **s1** `setup` parses as a single step OR `[{command, idempotent?, timeout_ms?, label?}]`; `runFittingSetup` runs every step in order, aborts on first non-zero; existing seed fittings (single-step) still install. Committed tests; typecheck+build clean.
- **s2** `FacultyDefinition.tier` present; the 7 new faculties exist with cardinality/shapes/tier; metadata accepts them as `faculty:` values; no faculty regressions. Committed tests.
- **s3** Catalog joins live discovery (StateModel) → authored descriptors (human + technical description, component_shape internal kind, faculty, tier, provides/consumes, setup steps, member primitives). `/api/promoted-fittings` returns them grouped. Committed tests over the descriptor authoring + grouping.
- **s4** `/compose` shows "Agent faculties" + "Dev faculties" headers grouping faculty tiles by tier; the old "Claude Code components" primitive-typed group is gone; promoted fittings render within their faculty; no primitive-type word is a user-facing label. e2e through the UI + walkthrough.
- **s5** Fitting detail shows a dedicated **Setup Instructions** section; add/edit/remove/reorder steps; autosaves; reload shows persisted steps; installer reads the same steps. e2e + walkthrough.
- **s6** grep shows no user-facing skill/hook/mcp/plugin label; `coord-mcp` (or one real seed) carries multi-step setup proving the installer path. Committed test.

## Notes
- Reuse existing discovery (`primitive-state.ts` StateModel via `/api/quarters`) + materialization (APM promote / presence). No parallel mechanism.
- PTY-everywhere: no setup step invokes `claude -p` / Agent SDK against Anthropic.
- groups: A sequential (schema→faculties→catalog), B (UI) after A, C last.
