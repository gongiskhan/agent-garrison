---
name: garrison-drill
description: Plan-driven, page-level QA against a live screencast of the app under test — author or update the Drill Book (drills/drillbook.yml + drills/pages/*.yml in the target app repo), pause at a configurable gate for approval, then run the enabled steps per selected viewport (vision or graduated e2e through the automations engine) and triage the resulting findings into a batch fix. One duty, two internal stages (plan, then run) with a gate between. Use for "run drill", "update the drill plan", "QA this page", or as the drill phase of a garrison build slotted after review. NOT the fast per-change gate (use garrison-test) and NOT a fresh-context independent pass (the blind adversarial drill run is a second invocation of this same skill, vision-forced, cache-bypassed, blind to specs).
---

# garrison-drill

## Policy-read preamble (soft - D5/D12)

At the start of every invocation, look for the compiled Orchestrator policy at
`~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`).

- **Policy present** (a Garrison run): it is the single authority. This skill
  carries NO model/effort pins - its execution parameters come from the policy
  matrix cell for its phase (`matrix[<phase>][<tier>]`), and its gate duties
  from the bindable phase-skill contract (the Orchestrator fitting's
  PHASE_SKILL_CONTRACT.md): do the phase's work in the run context handed to you
  (runDir, card, phase), write the phase's gate-status entry under the runDir,
  and print the phase's `GATE <phase>: <verdict>` line before choosing the next
  list.
- **Policy absent** (standalone, any repo): proceed with the caller-supplied
  context and sensible defaults - NEVER stop. Report to the caller rather than
  writing gate-status/run artifacts, and skip any board/run-engine steps.

## What "drill" means here — two internal stages, one duty (F1, R7)

Drill slots into the roster after `review`. It runs in two internal stages
inside the SAME phase, with a configurable gate between them (the gate lives
in the duty layer, not in a subagent — A5):

1. **Plan.** Read `drills/drillbook.yml` + `drills/pages/*.yml` from the target
   app repo (`GARRISON_DRILL_TARGET_REPO`, default the composition's project
   root). Diff the change against the pages already in the book — a git diff
   maps changed files to pages and pre-selects them for this run (S13). For
   each touched (or newly relevant) page, add/update steps: choose vision when
   judgment is needed (citation quality, generative output, canvas) and e2e
   when deterministic locators and assertions are evident (B9) — the same
   Router-routed pattern as the automations planner. Save via the Drill fitting's
   store (atomic writes; never hand-edit the YAML files directly).
2. **Gate.** `autonomy: "gated"` (drillbook.yml) holds here with the plan diff
   shown for approval — a human or agent "go" resumes into stage 2, same shape
   as the `discuss` duty's `gate: "explicit"` hold (one Kanban list, no list
   transition). `autonomy: "auto"` passes straight through, reporting after
   the run instead of before.
3. **Run.** Compile enabled steps per selected viewport to automations engine
   steps and run them as inline ephemeral runs (`contextTag: "drill"`, engine
   delta 1) — cache hit replays with no model call; miss falls to vision. Pool
   the results (failures, flipped verdicts, accepted UX findings, run-level
   observations) into the run report; confirmed findings dispatch as one batch
   fix card via kanban-loop (R10).

**The blind adversarial pass (R12, F8)** is a SECOND invocation of this same
skill, not a different one: a different model (set in the composition),
`contextTag: "drill-adversarial"`, `bypassCache: true` (engine delta 2, so it
is blind to the shared cache AND to any planner-authored `cachedAssertion`),
vision-forced (skip the e2e/graduated path even for steps that have graduated),
receiving ONLY the plan's areas and acceptance-level step descriptions — never
the emitted specs, never the cached actions. It writes its own probes. Its
findings join the same report.

## Direct runs - select a project, start its app, run (no card needed)

The Drill server also serves a card-free doorway, used by the UI's project
picker and available to this skill when a run targets a repo other than the
boot-time pin:

- `GET /api/projects` - the dev-root git repos (same list as the dev-env and
  Kanban pickers), each annotated with `runSkill` (its `run-<project>` skill,
  if any) and `hasDrillBook`.
- `POST /api/projects/select {path}` - retarget Drill live; the Book, pages,
  and run records all follow. The selection persists across restarts and
  wins over `GARRISON_DRILL_TARGET_REPO`.
- `GET /api/app/status` / `POST /api/app/start` - if the Book's app URL is
  not serving, start the app THROUGH THE PROJECT'S RUN SKILL: the server
  spawns a headless Claude Code session in the project root told to invoke
  `run-<project>` and print `APP_URL=<url>` when serving. Poll status until
  `reachable` (or the job fails with a reason). Never boot the app any other
  way when a run skill exists - the run skill is the project's single
  authority on how it starts (locality principle).
- `POST /api/plan/start` / `GET /api/plan/status` - stage 1 (Plan) on the
  direct path: a headless agent session in the project root authors/updates
  the Book on its own judgment (final-line sentinel `DRILL_PLAN_OK=<pages>` /
  `DRILL_PLAN_FAILED=<reason>`, OK verified against the page files on disk).
  An optional `{brief}` scopes the plan to a described change. An empty Book
  never asks the user to author pages - the UI's Run kicks this
  automatically; the Authoring surface is the manual override, not the
  required entry path.

## Skill conventions carried from garrison-test / garrison-adversarial-test (F9)

- **Deterministic wall first.** Order deterministic steps (e2e, cached
  assertions) before any step needing a model judgment (vision) within a run —
  cheapest checks before model spend.
- **Loaded-machine waits.** Emitted specs (Phase 5, graduation) carry generous
  waits for boot/login-class steps (60-90s). A pure timeout re-runs once in
  isolation; if it passes alone, fix the spec's wait, not the verdict.
- **Login-gated apps (auth).** If the app needs a login to reach its pages, the
  Drill Book's `auth` block carries the login — `loginPath`, the ordered login
  `steps`, and a `success` signal — with REAL test credentials (committed,
  test-only, never production). The runner logs in ONCE before the checks, in
  the shared browser context, so the session persists across runs (a cheap
  probe reuses it; the full flow re-runs only on a miss or a `cacheMinutes`
  refresh). A login failure collapses into ONE incident with the checks
  skipped — it NEVER reports N page failures for one auth problem. Author `auth`
  during Plan whenever a page is unreachable without a session; never leave a
  gated app to fail every check on its login screen.
- **Flaky/env re-run.** A flaky or environment failure re-runs once in
  isolation before it counts against the run, and never consumes a fix budget.
- **Findings must be reproducible, never an impression.** A fail carries the
  probe (screenshot/evidence path, or the exact assertion + observed value) or
  the exact commands + output — never "it felt broken."
- **Never clobber a live dev server.** Respect the dev-server hazard when
  driving a run against the app under test.

## GATE line

Print `GATE drill: <pass|fail|held> — <summary>` before choosing the next
list. `held` is the gated-autonomy pause (stage 1 complete, waiting on
approval) — not a pass or a fail, and does not advance the card.

---

Authoring/run/graduation/states surfaces referenced above are implemented in
the Drill fitting's own-port UI and the automations engine deltas; see
`fittings/seed/drill/` and `fittings/seed/automations/lib/` for the concrete
mechanics this skill drives.
