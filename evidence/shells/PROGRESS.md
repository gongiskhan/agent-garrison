# Shells run ledger

plan: /home/ggomes/.claude/plans/we-should-have-a-zesty-star.md (copied to docs/decisions/2026-09-03-shells-and-mesh-sessions.md)   model: Claude Sonnet 5   branch: main   head: 66c84865a3cee56e03b89ea01e6e45dc6455aa1b

| gate | status | commit | deploy | evidence dir | notes |
|---|---|---|---|---|---|
| G0 | doing | - | - | evidence/shells/g0/ | ledger + gitignore negation + decision doc |
| G1 | todo | - | - | evidence/shells/g1/ | local transport, runtime catalog, claude-sessions lift |
| G2 | todo | - | - | evidence/shells/g2/ | listers, hooks install, index publish, origin guard, manifest |
| G3 | todo | - | - | evidence/shells/g3/ | talk: aggregated list, live rail, direct-origin client |
| G4 | todo | - | - | evidence/shells/g4/ | talk: owned-shell workbench, external session view, new shell, styles |
| G5 | todo | - | - | evidence/shells/g5/ | cursor: stationing, quarters file sets, the mini |
| G6 | todo | - | - | evidence/shells/g6/ | csg: vs code tunnel, tether, preflight, installer, unstation |
| G7 | todo | - | - | evidence/shells/g7/ | csg install |
| G8 | todo | - | - | evidence/shells/g8/ | csg in the app |

## Mesh heads
dev-madrid 66c84865 @ 2026-09-03T16:37:41+01:00 | mini n/a | csg n/a

## Resume here
Start G0: write this ledger (done), commit .gitignore + evidence/shells/PROGRESS.md + the decision doc
(docs/decisions/2026-09-03-shells-and-mesh-sessions.md, already written but untracked). Then begin G1 per
the plan section 3: `fittings/seed/remote-shell-runtime/lib/transports.mjs` (localTransport, loadTransports,
localExec, transportExec, attachSpawnSpec, eventsTailSpec), `lib/tmux.shells.conf`, `lib/sessions.mjs`
(exec default, ensureAttached, #ensureEventsWatcher, stateDirExpr substitutions, loginShell, listProjects,
summary), `lib/runtimes.mjs` (RUNTIMES catalog, probeRuntimes, commandLine/shellQuote), `sessions.mjs start()`
runtime/resume/attach handling, `scripts/server.mjs` route additions, and lifting
`fittings/seed/dev-env/scripts/claude-sessions.mjs` into `packages/claude-pty/src/claude-sessions.mjs`.
Read every file before editing (line numbers in the Part 1 design report may have drifted).

## Open findings
(none yet)
