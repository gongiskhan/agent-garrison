# LANDING — Drill run-results overhaul

Run `20260725-030300-3a7ac388` · profile **build** · branch `main` · 2026-07-25

## What the brief actually turned out to be

The request read as a reporting/UX problem ("results are impossible to
analyse"). Three of the four symptoms were. The fourth was not: **Drill had no
interaction vocabulary at all.** A check compiled to `[navigate, verify]`, so
every behavioural criterion was judged from a screenshot of an untouched page,
the model passed it on whatever fragment was visible on load, and graduation
committed that as a Playwright spec that never performs the behaviour.

## Gates

| Gate | Result |
|---|---|
| typecheck | clean |
| lint | 0 errors on every touched file (also cleared 3 pre-existing errors) |
| unit/integration | **369 passed / 1 failed (3466 tests)** — the single failure is a load-contention flake in browser-persistent-profile.test.ts, 4/4 green in isolation, recorded in known-flakes.md |
| new tests | drill-video-tighten 13, drill-actions 15, drill-honesty-gate 11, curation +4, fixer +3 |
| live browser e2e | drill-spotter-capture-e2e green: 0 step-start frames, one step-end per check |
| live verification run | `01KYCB0G480JGAWKK1DPXE98E0`, 36 checks vs the `01KY4DREZ...` baseline |
| S6b live proof | needed a SECOND redeploy — three long-lived processes held pre-S6b code |

## Measured against the baseline

| | baseline `01KY4DREZ…` | after `01KYCB0G…` |
|---|---|---|
| wall clock | 27.8 min | **21.5 min** (while doing strictly more work) |
| run video | 27.3 min, 62 MB, 24.6 min dead air | **3.5 min / 11.1 MB**, 39 segments, produced automatically |
| spotter frames | 173, incl. ~36 mis-tagged `step-start` | 161, **0 `step-start`**, **36 `step-end`** |
| chunks with frames | 36 (but mis-attributed) | **36/36, 0 null-chunk** |
| Debrief scopes populated | **2 of 36** | **36 of 36** (72/72 candidates curated, 0 failed batches) |
| interactions performed | **0** | 18 checks drive the app |
| verdicts | 29 passed / 7 failed | 32 passed / 4 unrunnable |

## Deviations / things needing human eyes

1. **An unrelated change was swept into commit `f05811f`** — a pre-existing
   uncommitted `GARRISON_BIND_HOST` line in `drill/scripts/server.mjs`. Caught
   afterwards; the equivalent `browser-default` line was then split into its own
   commit (`7f61389`). The `f05811f` one remains mislabelled.
2. **A claim I reported was partly wrong.** I told the operator fixer retries
   desync step evidence. Refuted: the engine pushes no record for a non-terminal
   attempt. The reachable hazard is `insert_before` echoing the failing step's
   id; fixed at the root.
3. **ekoa-code changes are UNCOMMITTED by design** — 18 checks gained `actions`
   and lost stale graduated assertions. That tree already carried prior drill
   output and is not this task's repo. Operator should review and commit.
4. **60 stale assertions were wiped** from 49 `~/.garrison/automations/cache/drill-*.json`
   (action caches preserved; backup `cache.bak-1784972901`). Without this the
   honesty gate could never fire for an already-graduated check.
5. **The `unproven` state has unit proof but limited live proof** — this run
   produced 0 vision-path `unproven` verdicts because every behavioural check
   now has actions. The 4 `recovery-aborted` failures WOULD be `unproven` under
   S6b, which shipped after the run started. A focused re-run demonstrates it.
6. **Emitted specs are role/name-based**, so they bake Portuguese accessible
   names in and are brittle across i18n or copy changes.
7. **The 4 unrunnable checks need re-authoring**, not fixing in the app:
   two-direction toggles, multi-step sequences, ephemeral streaming states, and
   one that needs a non-super-admin fixture user to exist.

## Where to look

- Run results: https://dev-madrid.tail31efa.ts.net:8496 → run `01KYCB0G480JGAWKK1DPXE98E0`
- Plan + diagnosis: `docs/autothing/runs/20260725-030300-3a7ac388/FLOW_PLAN.md`
- Journal: `RUN_LOG.md`
