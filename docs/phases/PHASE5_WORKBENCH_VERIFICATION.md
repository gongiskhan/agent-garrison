# Phase 5 Workbench — Verification

**Implemented:** 2026-05-11
**Audited:** 2026-05-11 — see "Sequoias parity gap" at the end.
**Phase 5.5 (parity port) landed:** 2026-05-11

Phase 5 introduced the **Workbench** shell area — a `/workbench` page
that dynamically renders Fittings whose Faculty carries `family:
"workbench"`. Four Workbench Faculties (`terminal`, `screen-share`,
`worktree-management`, `session-view`) and four seed Fittings ship
with this phase.

Trenches verification (3 of 4 live scenarios) is at
`PHASE5_VERIFICATION.md`. This document covers the re-homing of
Trenches as Fittings and the new Workbench shell.

A 2026-05-11 audit caught that the initial implementation shipped
the shell pattern but not the Sequoias *engine* (port allocation,
env rewriting, Claude Code hook wiring). Those pieces were ported
the same day as Phase 5.5 — see the "Sequoias parity gap (closed)"
section at the bottom.

---

## 1. Workbench tab renders with installed Fitting tabs

**What it asserts:** `/workbench` appears in the Sidebar nav (between
Chat and Trenches). When 1+ Workbench Fittings are installed in the
active composition and the Operative is running, the Workbench page
shows a tab strip with one tab per Fitting.

**Evidence — structure:**

- `src/components/chrome/Sidebar.tsx` — Workbench `NavLink` at line
  after Chat; imports `Wrench` from lucide-react.
- `src/app/workbench/page.tsx` — Suspense wrapper over `WorkbenchPanel`.
- `src/components/workbench/WorkbenchPanel.tsx` — reads `composition`
  and `library` from `useAppShell()`, filters to faculties with
  `family === "workbench"`, renders a tab strip + active view.
- Empty state message when no Workbench Fittings installed:
  "No Workbench tools installed. Add a terminal, screen-share,
  worktree-management, or session-view Fitting to your composition..."

**Verification command:**
```bash
npm start
# Open http://localhost:3000/workbench
# With default composition running: 4 Fitting tabs visible
# Without composition: empty state message
```

---

## 2. Terminal Fitting tab renders TrenchesPanel

**What it asserts:** `terminal-armory-default` Fitting is declared
with `faculty: terminal`, `component_shape: plugin`, and its
`faculty-tab` view renders the existing `TrenchesPanel` (re-homed
from the standalone Trenches page).

**Evidence — files:**

- `fittings/seed/terminal-armory-default/apm.yml` — faculty: terminal,
  provides: terminal-session, ui.views[0] = faculty-tab.
- `src/components/trenches/TerminalView.tsx` — default-export wrapper
  accepting `FittingViewProps`, renders `<TrenchesPanel />`.
- `src/components/fitting-views/registry.tsx` — entry
  `"terminal-armory-default:main"` → `import("@/components/trenches/TerminalView")`.
- `compositions/default/apm.yml` — `terminal-armory-default` in
  dependency list.

All Trenches functionality (Open Orchestrator, Open Claude Code,
SSH host selector, multiple PTY sessions, busy/idle indicators)
is preserved via the re-homed TrenchesPanel. See `PHASE5_VERIFICATION.md`
§1, §2, §3 for live evidence of those scenarios.

---

## 3. Open Orchestrator from terminal Fitting

**What it asserts:** the Open Orchestrator button (in TrenchesPanel
re-homed as terminal Fitting view) builds and sends the correct
invocation: `claude --dangerously-skip-permissions
--append-system-prompt-file <assembled-prompt-path>`.

**Evidence:** identical to `PHASE5_VERIFICATION.md` §1 — the code is
unchanged; it's the same `buildOrchestratorCommand()` in
`TrenchesPanel.tsx`. No re-verification needed.

---

## 4. Screen-share Fitting tab renders viewer

**What it asserts:** `screen-share-default` Fitting is declared with
`faculty: screen-share`, and its view renders the `ScreenShareView`
component (Start/Stop controls + `ScreenShare` polling component).

**Evidence — files:**

- `fittings/seed/screen-share-default/apm.yml` — faculty: screen-share,
  provides: screen-share, ui.views[0] = faculty-tab.
- `src/components/trenches/ScreenShareView.tsx` — default-export,
  Start/Stop buttons, delegates to `<ScreenShare />` on start.
- Registry: `"screen-share-default:main"` → ScreenShareView.
- macOS Screen Recording permission gate: same caveat as
  `PHASE5_VERIFICATION.md` §4. The control plane and error path
  are wired; live capture requires the permission grant.

---

## 5. Worktree create/delete via WorktreeView

**What it asserts:** `worktree-management-sequoias` Fitting is declared
with `faculty: worktree-management`, provides `worktree`. Its view
calls `GET /api/workbench/worktrees?repoPath=<path>` to list,
`POST` to create, and `DELETE` to remove worktrees.

**Evidence — files:**

- `fittings/seed/worktree-management-sequoias/apm.yml` — faculty,
  config_schema.repo_path, provides: worktree, for_consumers.
- `src/lib/worktrees.ts` — `listWorktrees()`, `createWorktree()`,
  `removeWorktree()` via `git worktree` shell commands.
- `src/app/api/workbench/worktrees/route.ts` — GET/POST/DELETE handlers.
- `src/components/workbench/WorktreeView.tsx` — table of worktrees,
  create form (branch + base branch), Remove buttons.

**Verification command:**
```bash
# With repo_path configured in the Fitting's config:
curl "http://localhost:3000/api/workbench/worktrees?repoPath=$(pwd)" | jq .
# Should return { worktrees: [{...}, ...] }
```

---

## 6. Session badges from Sequoias state

**What it asserts:** `session-view-sequoias` Fitting reads
`~/.sequoias/state.json` and renders per-worktree status badges
(working/idle/waiting/errored/dead) polling every 5 seconds.

**Evidence — files:**

- `fittings/seed/session-view-sequoias/apm.yml` — faculty: session-view,
  consumes: worktree (optional-one) + terminal-session (optional-one).
- `src/lib/sequoias-sessions.ts` — `loadSequoiasSessions()` reads
  `~/.sequoias/state.json` synchronously; returns `[]` if absent.
- `src/app/api/workbench/sessions/route.ts` — GET handler.
- `src/components/workbench/SessionView.tsx` — table with status
  badges, 5 s auto-refresh, "Open terminal" button that POSTs to
  `/api/trenches/terminals` with the worktree path.

**State file caveat:** `~/.sequoias/state.json` is written by the
standalone Sequoias app. While T8 (Sequoias retirement) is pending,
both Sequoias and the Garrison SessionView read the same file.
Granting Sequoias Screen Recording permission is not required for
session badges — only Sequoias's Claude Code hooks write the file.

---

## Quality gates

- `npm run typecheck` — pass.
- `npm test` — 195 passed | 1 skipped (Phase 5.5 baseline including
  worktree-ports, worktree-env-rewriter, claude-hooks, and
  garrison-sessions test suites; 4 new Workbench seed Fittings all
  parse cleanly in `seed.test.ts`).
- `npm run lint` — pass. 0 findings.

## Live verification (2026-05-11 — run against `npm start`)

Two bugs found and fixed during this run:

1. **4 Workbench seed Fittings missing from `data/library.json`.**
   WorkbenchPanel iterates `library` (from `/api/library`) and filters
   by `WORKBENCH_FACULTY_IDS`. The 4 Fittings were not in
   `data/library.json`, so the panel always rendered the empty state.
   Fixed: added all 4 entries to `data/library.json`.

2. **`removeWorktree` read meta file after deleting the directory.**
   `git worktree remove --force` deletes the working directory, so
   `.garrison-meta.json` was gone when `removeWorktree` tried to read
   it. The branch was always `null`, so `removeSession` was never
   called and stale sessions accumulated. Fixed: read meta file before
   calling `git worktree remove`.

**Scenarios exercised:**

| Scenario | Result |
|---|---|
| §1 Workbench nav tab in sidebar | pass |
| §1 Library returns 18 entries (14 + 4 workbench) | pass |
| §1 Composition selections include all 4 workbench faculties | pass |
| §2 `terminal-armory-default:main` → `TerminalView` → `TrenchesPanel` | pass (registry + component) |
| §3 `buildOrchestratorCommand` wired in `TrenchesPanel` | pass |
| §4 `screen-share-default:main` → `ScreenShareView`; screencapture available | pass |
| §5 `GET /api/workbench/worktrees` — main worktree, isMain: true | pass |
| §5 `POST /api/workbench/worktrees` — creates dir + meta + session | pass |
| §5 `DELETE /api/workbench/worktrees` — removes dir + session | pass (after fix 2) |
| §6 `POST /api/workbench/sessions/install-hooks` — installs `_garrison` marker | pass |
| §6 `POST /api/workbench/sessions/hook` — `UserPromptSubmit` → matched: true | pass |
| §6 `GET /api/workbench/sessions` — returns session with status `working` | pass |
| §6 Hook event updates `lastStatus` in `~/.garrison/sessions/state.json` | pass |

## Sequoias parity gap (closed 2026-05-11 — Phase 5.5)

A same-day audit found that the initial Phase 5 implementation
shipped the Workbench shell and CRUD but not the Sequoias *engine*
(port allocation, env rewriting, hook wiring). Phase 5.5 closed
the gap. Each piece below has shipped:

1. **Deterministic port allocation — shipped.**
   - `src/lib/worktree/ports.ts` ports Sequoias's FNV-1a hash. Port
     range 50000–54999. `allocatePort(branch, service)` returns a
     stable port per `(branch, service)` pair; collisions probe
     forward with `lsof -iTCP:N -sTCP:LISTEN -t` and wrap on
     overflow.
   - Wired into `createWorktree` via `rewriteEnvFiles`.
2. **Env-file rewriting and `package.json` patching — shipped.**
   - `src/lib/worktree/env-rewriter.ts` ports Sequoias's full env
     pipeline: `discoverEnvFiles`, `readMainPortMap`,
     `rewriteEnvFiles`, `ensureWorkspacePortFiles`. Same logic for
     `*_PORT`, `localhost:N` URLs, per-package `.env` injection,
     `NEXT_PUBLIC_*` mirroring.
   - `src/lib/worktree/package-json-patcher.ts` ports
     `patchFrontendDevScripts`. Marker renamed to
     `GARRISON_FRONTEND_PORT`. Idempotent.
3. **Claude Code hook wiring — shipped.**
   - `src/lib/claude-hooks.ts` ports Sequoias's
     `installHooks/restoreHooks`. Hooks are POSTed to
     `/api/workbench/sessions/hook`, derived from the request
     origin so the URL always matches the running Garrison
     instance.
   - `worktree-management-sequoias/scripts/setup.sh` calls
     `POST /api/workbench/sessions/install-hooks` during the
     runner's setup phase.
   - `src/lib/garrison-sessions.ts` writes session state to
     `~/.garrison/sessions/state.json` and exposes
     `setSessionStatus`, `findSessionByCwd`, etc.
   - Session-view reader merges `~/.garrison/sessions/state.json`
     with `~/.sequoias/state.json` during the migration window;
     Garrison wins on conflict.
4. **State-path drift — partially addressed.**
   - Session state moved to `~/.garrison/sessions/state.json`
     (Garrison-owned). Worktree directories continue to use
     `~/.worktrees/<repo>/<slug>` (Sequoias convention). Keeping
     `~/.worktrees/` is intentional: it matches Sequoias's actual
     behavior so worktrees created either way coexist.

**Where the live status pipeline now flows:**

```
Claude Code spawns in /wt/<branch>
  → settings.json hook fires curl POST {event, cwd}
  → /api/workbench/sessions/hook receives
  → findSessionByCwd(cwd) → {projectPath, branch}
  → setSessionStatus(...) updates ~/.garrison/sessions/state.json
  → SessionView reads merged state next poll (5s) and re-renders
```

**T8 (Sequoias retirement) status:** still gated on the 3-day
daily-use validation milestone — but the parity blocker is removed.

## T8 deferred

Sequoias retirement is deferred only by the 3-day daily-use gate.
The parity gap that previously also blocked T8 closed with Phase
5.5. Gate: use the Workbench daily for 3 days, then retire the
standalone Sequoias install.
