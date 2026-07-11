# Flow Plan

<!-- The build plan for ONE run. garrison writes/updates this in Phase 1 (via garrison-plan) at docs/autothing/runs/<runId>/FLOW_PLAN.md — a per-run path, never a shared docs/FLOW_PLAN.md — and updates each slice's Status as it builds (durable resume — progress is re-read from here + gate-status files, never from memory). Keep the table current. -->

## Slices
<!-- A slice = one user-facing flow or feature, small enough for a 60-90s walkthrough. Order by dependency; mark which can run in parallel. Kind: ui | api | mixed. Kind drives the kind-conditional gates (Part 8.2): ui/mixed get design-audit + walkthrough + a per-slice independent test; api slices keep asciinema evidence (no design audit) and their independent-test pass is batched at the run level. -->

| # | Slice ID | Title | Kind | Routes to (area skill) | Parallel group | Status |
|---|----------|-------|------|------------------------|----------------|--------|
| 1 | {{slug}} | {{title}} | ui | {{area}} | A | pending |
| 2 | {{slug}} | {{title}} | api | {{area}} | A | pending |
| 3 | {{slug}} | {{title}} | mixed | {{area}} | B (after A) | pending |

<!-- Status: pending | in_progress | passed | blocked. Mirror of each slice's gate-status.json status. -->

## Acceptance per slice
<!-- Concrete, testable outcome each slice must reach. Seeds the Playwright assertions AND the walkthrough expectedScreen beats. -->
- **{{slug}}**: {{e.g. "Logged-in user lands on /dashboard; SSO session persists across reload; no console errors."}}

## Parallelism
- Group A slices are independent → build concurrently (one worker each, area skill + acceptance pasted into the worker prompt).
- Group B depends on A → starts after A's slices reach `passed`.

## Global acceptance
See `governance.md`. Tracked in `<runDir>/evidence-index.json → globalGate` (`<runDir>` = `docs/autothing/runs/<runId>/`).
