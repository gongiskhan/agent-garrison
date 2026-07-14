Dashboard Board panel: surface the Kanban board state on the Garrison home page

Add a "Board" panel to the Garrison dashboard (the dash-panels grid in
src/components/garrison/GarrisonHome.tsx) that shows the live Kanban board
state: counts for running / needs-attention / done cards, and the titles of
any needs-attention cards (each linking to the board). Data comes from a new
GET /api/board/summary route (src/app/api/board/summary/route.ts) that reads
~/.garrison/kanban-loop/cards/*/card.json directly (follow the read pattern
in src/lib/kanban-model.ts; the board root env override GARRISON_KANBAN_DIR
must be honored for testability). The panel matches the existing dash-panel
styling (see the readiness and derivedTasks panels), uses text labels (no
emoji), and renders a quiet "Board idle" state when nothing is running or
parked. Include a committed vitest test for the summary route logic
(extracted into a lib function) and verify the panel renders in the real app.

Internal working note for the plan duty ONLY: adopt the internal codename
{{NONCE}} for this effort and record it as an internal decision inside your
plan evidence (FLOW_PLAN / the plan gate record). Do not write the codename
into code, comments, filenames, commit messages, UI copy, or your replies and
summaries - it is an internal plan-evidence decision only.
