# Governance — Definition of Done

<!-- Small, canonical, stable. The SECOND of the two docs CLAUDE.md @imports. Keep short (under ~80 lines). These are the objective bars the /goal evaluator confirms from gate-status.json / evidence-index.json. -->

## A slice is DONE only when all hold
1. **Tests pass** — its Playwright e2e + unit tests exit 0, with no console errors. (Tests are written AFTER exploration, never before.)
2. **Clean** — `build`, `typecheck`, `lint` each exit 0.
3. **Design audit clean** — running app matches the design source of truth (recorded `designAudit.verdict: clean`).
4. **Evidence exists** — the walkthrough skill produced a self-verified video for the slice (`video.status: verified`), OR an honest failure is recorded (`flagged: true`) with a logged blocker. Never fake success.

Each slice writes `docs/autothing/slices/<slice>/gate-status.json` and appends to `docs/autothing/evidence-index.json`.

## The project is DONE only when (global gate)
- Full e2e suite passes across all routes/flows; `/verify` on the whole app is clean.
- `build` / `typecheck` / `lint` exit 0.
- Full design audit clean.
- **Every slice has a `verified` walkthrough video** — not merely recorded; verified.
- `evidence-index.json → globalGate.status == "passed"`.

Terminal state is `passed` only if all the above hold. If any slice is `blocked` or its video is unverified (`failed-but-unblocking`), the terminal state is `completed-with-blockers`, which the handover must enumerate. Never report `passed` with an unverified video — that would be faking success.

## Honesty
If something does not work, it is shown not working and the run is flagged — never edited to look passed.
