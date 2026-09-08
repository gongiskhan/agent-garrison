# G6 - fittings in the app

Gate: every equipped fitting's view is reachable inside the Garrison app, at
phone width, without leaving the shell.

## What shipped (D43)

- Own-port rows in the sidebar split on the bridge, not on width. A phone
  BROWSER keeps the new tab (the iframe beside the rail is cramped). The app
  has no tabs, so with a native bridge present every own-port view embeds at
  `/embed/<id>`, the same route desktop uses.
- At phone width the embed route drops the rail (`shell-embed-full`) and
  carries a bar: safe-area inset, Back (history back, home when there is
  none), the fitting's library name, Menu (opens the drawer).
- Desktop and tablet unchanged: rail + iframe, no bar.
- Embedded (non-own-port) fitting views already rendered inside the shell at
  `/fitting/<id>`; nothing changed for them.

Files: `src/components/chrome/Sidebar.tsx`, `src/components/chrome/AppShell.tsx`,
`src/app/embed/[fittingId]/page.tsx`, `src/app/globals.css`,
`tests/e2e/embed-in-app.spec.ts` (new), `tests/e2e/shell-overhaul.spec.ts`
(two stale tests repaired).

## Evidence in this directory

- `playwright-embed.txt` - `tests/e2e/embed-in-app.spec.ts` on desktop-chromium
  and mobile: 3 passed, 3 skipped by width gating (each case runs where its
  width applies).
- `playwright-related.txt` - `capture-page`, `embed-in-app`, `shell-overhaul`
  together; the six failures in the first run were `shell-overhaul`'s two
  pre-existing stale tests (searchbox renamed 2026-08-28, Fittings group
  collapsible) times three projects; repaired, 12 passed.
- `typecheck-vitest-reload.txt` - `tsc --noEmit` clean; 6 vitest files / 73
  tests green; `npm run node:reload` deployed the change to this node.
- `sim-embed-kanban.png` - the app on the iPhone 17 Pro simulator (mini),
  cold-started with `GARRISON_OPEN_PATH=/embed/kanban-loop` against this
  node over tailnet (dummy capture token): bar with Back / "Kanban Board" /
  Menu under the status bar, no rail, the Kanban Loop board full width.

## Found on the way

The runner's one-shot orphan sweep (`reconcileOrphanedOwnPortFittings`, fired
by the first `/api/runner/<id>/state` read of a server process) SIGTERMs the pid
named in any own-port status file whose composition is not running. The spec's
fake `kanban-loop.json` named the Playwright worker's own pid, so the sweep
killed the test runner mid-test ("Target page, context or browser has been
closed" with no primary error). The spec now triggers the sweep before the
fake file exists and names no pid.

## Phone criterion (operator)

The simulator is iteration, not proof. On a real phone with the TestFlight
build and this node added: open the menu, tap an own-port fitting (Kanban
Loop, Dev Env, File Browser), confirm the view fills the screen under the
bar, Back returns to the previous page, Menu opens the drawer, and a
non-own-port fitting still opens at `/fitting/<id>`. No native code changed in
this gate, so the G5 TestFlight build (run 33633051836, success) is the build
to use.
