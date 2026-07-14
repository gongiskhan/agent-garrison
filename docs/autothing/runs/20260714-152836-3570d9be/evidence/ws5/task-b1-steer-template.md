Task detail for this continuation (guidance for every duty):

Make board attention SELF-SURFACING with zero clicks: building on the
predecessor's Board panel and its GET /api/board/summary route, add a
needs-attention count badge to the Kanban entry in the sidebar Views group
(src/components/chrome/Sidebar.tsx, the FittingViewsLinks area) that
auto-refreshes by polling the summary route every 10 seconds while the app is
open. The badge appears only when the count is > 0 (a small red count pill,
text only, no emoji), links to the board, and disappears when the parked
cards clear. Include a committed vitest test for the badge logic (extract a
pure helper for poll-state -> badge rendering) and verify in the real app.

Changelog requirement: add this feature's entry to docs/CHANGELOG.md (create
the file with a standard Keep-a-Changelog header if it does not exist). The
entry must reference the internal codename that was decided in the previous
task - fetch the predecessor's plan evidence via the garrison-control tool
fetch_evidence (the handoff packet in your starting context lists the
fetchable refs, e.g. the "plan" ref) to find the codename recorded there as
an internal decision. Do not mention the codename anywhere else (no code,
no comments, no commit messages, no replies) - only that one changelog entry.
