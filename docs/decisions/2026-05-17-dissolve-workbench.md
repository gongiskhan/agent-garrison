# Dissolve the Workbench — 2026-05-17

## Decision

The Workbench scaffold is dissolved. The five Faculties previously tagged
`family: "workbench"` (Terminal, Screen Share, Worktree Management, Session
View, Outposts) are promoted to flat top-level Faculties. Each one ships
its own React UI bundled with esbuild and serves it on its own HTTP port,
following the **Monitor pattern** locked in `docs/UI-FITTINGS.md`.

No parent container. No tabbed shell at `/workbench`. No `family:
"workbench"` field. Coupling between Fittings is `provides` / `consumes`
only.

## Motivation

The Workbench was introduced because Terminal, Worktrees, Session View, and
Screen Share felt like "developer tools that group together." Outposts was
later folded into the same family. Two consequences emerged:

1. **Placement ambiguity.** Every new tool-like capability raised "is this
   Workbench or top-level?" Decisions were arbitrary and drifted across
   briefs.
2. **App-framework gravity.** A container with children pulled Garrison
   toward layout, tab management, focus, inter-child messaging, an in-
   process event bus (`workbench-bus.ts`), a server-side event bus
   (`workbench-server-bus.ts`), and a Workbench-only prefs store
   (`workbench-prefs.ts`). Garrison hosts Operatives and the tools around
   them; it isn't a UI framework for panel arrangement.

Garrison's existing Faculty / Fitting model plus `provides` / `consumes`
wiring is sufficient. The React + esbuild UI service pattern is proven.

## Locked clarifications

| Question | Resolution |
|---|---|
| Outposts is a 5th workbench-family Faculty — in scope? | Yes. All five dissolve. |
| Where do the five appear in the left nav? | Nowhere as embedded surfaces. Each Fitting serves its own port (Monitor pattern). The Garrison shell renders a thin `/tools` discovery list that reads `~/.garrison/ui-fittings/*.json`. |
| Rename of `mode: "workbench"`? | `"interactive"`. Generic for any UI-tab-driven session. |
| Rename of `X-Garrison-Origin: "workbench"`? | `"ui-tab"`. Distinct from `"channel"`. |
| Keep Sequoias suffixes? | Yes. `worktree-management-sequoias` and `session-view-sequoias` keep their names per the brief's anti-target. |

## Well-known ports

| Fitting | Default port |
|---|---|
| `terminal-armory-default` | 7078 |
| `screen-share-default` | 7079 |
| `worktree-management-sequoias` | 7080 |
| `session-view-sequoias` | 7081 |
| `outpost-tailscale-host` | 7082 |
| `monitor-default` (reference template) | 7077 |

Each Fitting falls back to the next free port if its default is taken, and
writes a status file at `~/.garrison/ui-fittings/<fitting-id>.json` carrying
`{ fittingId, port, url, pid, startedAt }`. Status files are removed on
SIGTERM.

## Disposition table

**Migrate (logic moves into Fittings):**

| Source | Destination |
|---|---|
| `src/components/workbench/SessionView.tsx` | `session-view-sequoias/ui/main.tsx` (rewritten standalone) |
| `src/components/workbench/WorktreeView.tsx` | `worktree-management-sequoias/ui/main.tsx` |
| `src/components/trenches/TerminalView.tsx` | `terminal-armory-default/ui/main.tsx` |
| `src/components/trenches/ScreenShareView.tsx` | `screen-share-default/ui/main.tsx` |
| `src/app/api/workbench/worktrees/route.ts` | `worktree-management-sequoias/scripts/server.mjs` |
| `src/app/api/workbench/sessions/*` | `session-view-sequoias/scripts/server.mjs` |
| `src/app/api/workbench/outposts/*` | `outpost-tailscale-host/scripts/server.mjs` |
| `src/app/api/trenches/terminals/*` | `terminal-armory-default/scripts/server.mjs` |
| `src/app/api/trenches/screen-share/*` | `screen-share-default/scripts/server.mjs` |
| `scripts/trenches-ws.mjs` (PTY WS server) | `terminal-armory-default/scripts/server.mjs` (slim port) |

**Lift-and-rescope (general utility — survive in a properly scoped
location):**

| Item | New location / change |
|---|---|
| `src/lib/garrison-sessions.ts` | Stays in `src/lib/`. `mode: "workbench"` → `"interactive"`. Multi-consumer infrastructure; not workbench-specific. |
| `src/lib/mcp-gateway/launch.ts` | Stays in `src/lib/`. Any temp-path strings carrying "workbench" get renamed in a follow-up. |
| `src/components/chat/ChatPanel.tsx` `X-Garrison-Origin` header | Stays. Value renamed `"workbench"` → `"ui-tab"`. |
| Per-Fitting esbuild + React build pipeline | Becomes canonical for all UI Fittings. Already standardized in `docs/UI-FITTINGS.md`. |

**Delete (no general utility; existed only because Workbench existed):**

- `src/app/workbench/page.tsx`
- `src/components/workbench/` (entire dir)
- `src/components/trenches/` (entire dir)
- `src/lib/workbench-bus.ts`, `src/lib/workbench-server-bus.ts`,
  `src/lib/workbench-prefs.ts`
- `src/app/api/workbench/` (entire tree)
- `src/app/api/trenches/` (entire tree)
- Sidebar link `<NavLink href="/workbench" label="Workbench" />`
- `WORKBENCH_FACULTY_IDS` set
- Registry entries for workbench-Fitting view IDs in
  `src/components/fitting-views/registry.tsx`
- `tests/workbench-server-bus.test.ts`, `tests/api-spawn-soul-tab.test.ts`,
  `tests/api-worktrees-route.test.ts`, `tests/api-worktrees-close.test.ts`,
  `tests/e2e/phase9.spec.ts`
- The `family: "workbench"` annotations on five Faculty entries in
  `src/lib/faculties.ts` (done, this ADR's "Phase 3")
- The `family?: "workbench"` field on `FacultyDefinition` in
  `src/lib/types.ts` (done)

## Anti-targets honored

- `fittings/seed/http-gateway/` (locked)
- `fittings/seed/mcp-gateway/` (locked except literal "workbench" temp-path
  string renames if any)
- `fittings/seed/garrison-orchestrator/` `[orchestrator-active]` reply
  contract (untouched)
- `compositions/*/apm.yml` `selections:` keys (untouched — keyed by Faculty
  id which is unchanged)
- README (already meets the positioning brief)
- The Monaco-based local Fitting editor (untouched)
- `worktree-management-sequoias` / `session-view-sequoias` keep their
  suffixes
- OAuth Max plan auth (no `ANTHROPIC_API_KEY` introduced)

## Status when this ADR landed

All five Fittings ported, built, and verified end-to-end (status file
present, `/health` 200, real interaction paths exercised). One cross-
Fitting wiring assertion proven live: worktree created via
`worktree-management-sequoias` on port 7080 was observed in
`session-view-sequoias`'s `/sessions` on port 7081, by reading the same
`~/.garrison/sessions/state.json`. PTY-over-WebSocket round-trip on
`terminal-armory-default` was verified by sending
`echo dissolve-marker-7c4e\r` and observing the marker back in the WS
stream.

Phase 3 (drop `family`, rename `mode`/`origin`) landed; `npm run
typecheck` exits 0.

**Still owed** (subsequent goal-loop iterations):

- Phase 4: physically delete the Workbench scaffold from the Garrison
  Next.js shell. The five Fittings are ready to take over; Garrison-shell
  imports of the deleted modules will need to be unwired in lock-step.
- Phase 5: `/tools` discovery page that reads
  `~/.garrison/ui-fittings/*.json` and renders a list of healthy Fittings.
- Phase 7: live Playwright run on the Max plan that exercises each Fitting
  in a real Chromium and asserts the orchestrator chat names all five
  Faculties + ends with `[orchestrator-active]`. This depends on the
  composition wiring still working after the Phase 4 deletes.
