# BRIEF-DRILL-V1 - build the Drill fitting from the annotated mock

You are building Drill, Garrison's visual, agent-driven QA fitting, end to end in this session. The spec is the annotated mock at the repo root: `./drill-mock.jsx`. This brief tells you how to read it, what to build, in what order, and exactly what must be tested. How you execute (subagents, parallelism, tooling) is your call. You are good at long autonomous runs; plan accordingly and do not stop for questions unless a hard constraint is impossible.

## How to read the spec

Read `drill-mock.jsx` fully before anything else. It is a working React mock AND the requirement ledger:

- The `A` object holds every annotation, keyed by view. Each entry has a kind stamp: REUSE (bring it over from the named fitting; the `src` field is the file to read before implementing), NEW (build it), EXT (external library or pattern), REPLACES (retire the named Garrison piece), DECISION (already settled, do not relitigate).
- `SPECS` (S1..S29) is the full requirement inventory. Every S item must exist in the shipped fitting.
- `DECISIONS` (R1..R14) are binding. If real code makes one impossible as written, do the closest compliant thing and record it as a FINDING; do not silently drop it.
- `QUESTIONS` (Q1..Q9) are all resolved; their resolutions are requirements.
- The mock's views are the target UI: Drill Book, Authoring, States, Run & results, Mobile, Garrison. Its JSX, copy and Garrison tokens are the reference; port structure and copy, adapt to the repo's real UI conventions.

## Phase 0 - explore first

Read before writing: `fittings/seed/automations/lib/*` (engine, browser-orchestrator, cache, fixer, fingerprint, planner, discuss, store), `fittings/seed/browser-default/scripts/server.mjs` (screencast, observe, execute locator ladder, CDP passthrough), `fittings/seed/kanban-loop`, `fittings/seed/duty-test`, `fittings/seed/duty-walkthrough`, `fittings/seed/duty-adversarial-test` (its SKILL.md decorrelation rules carry into Drill), the resolver and duty roster wiring in `src/lib/`, and the orchestrator phase-skill contract.

Print one `FINDING-En: <sentence>` line per material discovery, including at minimum:
- FINDING for how duty fittings register in the roster and how a duty gets two internal stages with a gate.
- FINDING for the right UI vehicle for Drill's surface: automations-style static dist on its own port versus a richer setup. Pick whichever lets the mock's JSX port most directly while matching how own-port plugin fittings serve UI today.
- FINDING for how the heartbeat / periodic pickup mechanism works today, for report dispatch.
- FINDING for any mock assumption that does not match real code, with the adaptation you chose.

End Phase 0 with `PHASE0_OK`.

## Pre-decided for this run (D1..D6)

- D1: Engine deltas land inside the automations fitting as general features. Drill consumes them over the automations HTTP API. No shared library extraction this run. Deltas must carry no drill-specific naming (Garrison Honesty Test).
- D2: The seven engine deltas from annotation F6, plus a cache-bypass flag on inline runs (needed by the blind adversarial pass, R12).
- D3: Retired duties (walkthrough, validation, adversarial-test) are parked in the composition, not deleted. Fittings stay in seed. Use the repo's parked terminology.
- D4: Element picking uses @medv/finder (MIT) injected via the browser fitting, biased to data-testid, role, aria-label. Fallback if unavailable: css-selector-generator.
- D5: Ship a small deterministic fixture app inside the Drill fitting's test assets: two pages (a chat-like page with citation markers and a sources list; a build page with idle/building/complete states driven by a start button and a timer), plus one intentional bug you can flip on (citation index mismatch). All vision self-tests run against this fixture so they are reproducible. Dogfooding against Garrison's own UI is a bonus, not the gate.
- D6: No model or effort pins anywhere in Drill's skill. Policy-read preamble exactly as in existing duty skills (annotation F9).

## Build order and sentinels

Each phase ends by printing its sentinel on stdout after its checks pass.

1. Engine deltas in automations (D2), each with unit tests: inline ephemeral runs with a context tag, cache-bypass flag, step enable flags and tags, richer deterministic assertions (text contains, count, visible, url matches, attribute equals), viewport emulation per run, run matrices across viewports with grouped results, per-step evidence capture written as plain files with links (no artifact store, R13). `ENGINE_DELTAS_OK`
2. Drill fitting skeleton: apm.yml (own port, component_shape plugin, provides duty drill, consumes automation-runner and browser surfaces per annotation F7), store for the Drill Book in the target repo (`drills/drillbook.yml`, `drills/pages/*.yml`, atomic writes), skill with policy preamble and GATE line conventions. `DRILL_SKELETON_OK`
3. Authoring surface: screencast canvas embed, picker (CDP DOM and Overlay through the browser fitting plus @medv/finder), areas with multi-anchor and percentage rects and stable page#area ids, plan column with page-level steps, per-area steps, checkbox enable, cross remove, add step, add area, vision/e2e toggle, cross-page ref chips, state strip. `DRILL_AUTHORING_OK`
4. Run path: compile enabled steps to engine steps, run per selected viewport, results surface with tier badges, evidence links, per-step feedback on any verdict, mark failed override, run-level observations that become draft steps and findings, findings report with confirm/dismiss triage, dispatch modes Manual, Heartbeat, Immediate, batch fix card carrying the report (R10, R14). `DRILL_RUN_OK`
5. Graduation: spec emission from cached actions and assertions into `tests/drills/<page>.spec.ts`, toggle flip to e2e, drillJudge() Router helper for judgment assertions (Q3), healer fallback that re-runs a broken e2e step in vision and re-emits, loaded-machine waits baked into emitted specs (F9). Emitted specs must re-run green with zero model calls. `DRILL_GRADUATE_OK`
6. States: snapshots from observe kept on the run timeline, promote to named state, matcher per R11 (assertion passing IS a match; fingerprint pre-filter at 0.85 shape similarity; ambiguity escalates to vision, never guesses; vision confirmation writes back an assertion), reach paths compiled as engine steps, state-scoped areas and steps, authoring on the state screenshot. `DRILL_STATES_OK`
7. Garrison integration: drill duty in the roster after review with plan stage, configurable gate, run stage (R7); testing-only cards with the R14 drill block entering at drill; heartbeat dispatch pickup; walkthrough, validation and adversarial-test parked (D3); adversarial pass as a second run, blind to specs and cache, vision-forced, model from the composition (R12, F8). `DRILL_ROSTER_OK`
8. Mobile and responsive pass on Drill's own UI: FAB plan sheet, highlight flow (close sheet, pick with enlarged targets, reopen with new area), usable at phone width. `DRILL_MOBILE_OK`
9. Self-test (see below). `DRILL_SELFTEST_OK`

## What must be tested - be thorough, use vision

Unit tests cover the engine deltas and the matcher math. Everything user-facing is tested end to end against the D5 fixture app, driving Drill's real UI. Use vision-driven verification (through the engine or screenshots you actually inspect) wherever correctness is visual; do not settle for DOM assertions on visual claims. The non-negotiable list:

1. Picker: pick three elements on the fixture, verify captured multi-anchors; reload the page and change viewport, verify every badge still sits on its element (vision: inspect the screenshot, badge overlaps target).
2. Step CRUD: add, disable, re-enable, remove; verify the page YAML reflects each change (atomic write, read-back).
3. Vision to e2e: run a vision step against the fixture chat page, verify the emitted spec exists, is readable, and re-runs green with zero model calls; verify the toggle flipped.
4. Judge helper: a citation-quality step emits with drillJudge(), and the emitted spec passes on the good fixture and fails when the fixture bug flag is on.
5. Healing: rename a testid in the fixture, re-run the e2e step, verify tier recovered, re-emitted spec, green again.
6. States: promote a building snapshot, verify the matcher accepts build 8% and build 64% and rejects idle and complete (R11 thresholds); run a state-scoped step and verify the reach path executed first and was cached on the second run.
7. Findings flow: add a note on a passing step, mark it failed, add an observation, confirm two findings, dismiss one, dispatch Manual, verify exactly one batch card carrying the report; verify Heartbeat mode picks up confirmed findings without the button.
8. Blind adversarial pass: run it against the fixture with the bug flag on and verify it fails with a reproducible probe while having received no spec or cache (assert the prompt/context contents).
9. Viewport matrix: same steps at desktop and mobile emulation produce separate verdicts; the fixture has one mobile-only failure to catch.
10. Gated versus autonomous: gated pauses with a plan diff before running; autonomous proceeds and reports.
11. Testing-only card: create one with the R14 block, verify it enters at drill and a failure produces the batch fix card into the normal pipeline.
12. Drill's own UI at mobile width: FAB and highlight flow work under touch-sized targets (vision check the sheet and pick overlay).
13. Full Drill on the fixture book: both pages, both viewports, one run, grouped results.

A failing item is a defect to fix in this session, not a note. Flaky or environment failures re-run once in isolation before counting (F9 conventions).

## Hard constraints

- Never create branches. Never specify /goal.
- Atomic writes everywhere: read immediately before write, subtree-only mutation, temp-rename, read-back verification.
- The Resolver stays untouched except duty registration.
- Fixer fencing is preserved exactly; drill adds no new step types to what the fixer may introduce.
- No artifact store anywhere in new code: plain files with links, File Browser views them (R13).
- Engine changes must be justifiable as general automations features on their own.
- UI copy in plain English, sentence case, no em dashes. Coined terms (Drill, Drill Book, Full Drill) stay as coined.
- Reuse Garrison's visual tokens; Drill must look native to the shell.

## Out of scope this run

Visual regression (BackstopJS or Lost Pixel), runner click-through of cross-page refs, video recording, any Ekoa porting, the Garrison website, removal of parked fittings.

## Carried and superseded

The mock supersedes `drill-design-draft.md` and all earlier drafts. The mock's own Ledger tab records prior supersessions (Midscene/Stagehand embed, per-row Send to fix, walkthrough keep-both); honor them.

## Close-out

Append a debrief to RUN_LOG.md per repo convention: what shipped per phase, findings, deviations from the mock with reasons, and the test evidence locations. Then print the final acceptance sentinel as the last stdout line:

`DRILL_V1_ACCEPTED`
