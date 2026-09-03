# Shells run ledger

plan: /home/ggomes/.claude/plans/we-should-have-a-zesty-star.md (copied to docs/decisions/2026-09-03-shells-and-mesh-sessions.md)   model: Claude Sonnet 5   branch: main   head: 3f457a6b0715e5d4cab3ad753e459873a0bb52a5

| gate | status | commit | deploy | evidence dir | notes |
|---|---|---|---|---|---|
| G0 | done | 5af91f9021d8 | none (docs only) | evidence/shells/g0/ | ledger + gitignore negation + decision doc |
| G1 | done | 3f457a6b0715 | redeploy @ 2026-09-03T17:51Z | evidence/shells/g1/ | local transport, runtime catalog, claude-sessions lift; verified live on dev-madrid (csg transport unaffected) |
| G2 | todo | - | - | evidence/shells/g2/ | listers, hooks install, index publish, origin guard, manifest |
| G3 | todo | - | - | evidence/shells/g3/ | talk: aggregated list, live rail, direct-origin client |
| G4 | todo | - | - | evidence/shells/g4/ | talk: owned-shell workbench, external session view, new shell, styles |
| G5 | todo | - | - | evidence/shells/g5/ | cursor: stationing, quarters file sets, the mini |
| G6 | todo | - | - | evidence/shells/g6/ | csg: vs code tunnel, tether, preflight, installer, unstation |
| G7 | todo | - | - | evidence/shells/g7/ | csg install |
| G8 | todo | - | - | evidence/shells/g8/ | csg in the app |

## Mesh heads
dev-madrid 3f457a6b @ 2026-09-03T17:51Z (local HEAD; 2 ahead / 4 behind origin/main, push deferred - see Open findings) | mini n/a | csg n/a

## Resume here
G1 is done and live on dev-madrid. Start G2 per the plan section 3: listers
(`fittings/seed/remote-shell-runtime/lib/listers/{claude,codex,cursor,gemini}.mjs`), `lib/session-index.mjs`
(buildIndex, status precedence, claim tagging via thread files + cards), the hook installer
(`scripts/install-hooks.mjs` / `uninstall-hooks.mjs` for Cursor/Codex/Gemini - REMOTE_EVENT_HOOK is now
`buildEventHook(eventsFilePath)`, already gained the `runtime` positional in G1, reuse it), the state-service
index publisher (`lib/index-publisher.mjs`, add `fittings/seed/remote-shell-runtime/lib/state-client.mjs` to
`scripts/sync-state-client.mjs` SYNC_MANIFEST and run it), the origin/CORS guard (`lib/origin-guard.mjs`,
ported from `src/lib/mesh/peer-auth.ts` isTrustedHost), and the apm.yml/library.json manifest updates. Note:
G1's `summary()` deliberately did NOT add `node`/`threadId` fields yet (no node-identity.mjs existed); G2's
`lib/node-identity.mjs` should add those to `summary()` too, not just to session-index.mjs rows.

## Open findings
F-000 [source: g0-recon] [status: open] origin/main has diverged (4 commits from node/goncalos-macbook-pro's
  convergence, incl. kanban card-conversation work) while a THEN-live autonomous operative on this exact
  checkout had uncommitted WIP in fittings/seed/kanban-loop/{dist,ui/main.tsx,ui/styles.css} and
  compositions/default/apm.yml (unrelated to this plan). `git merge origin/main` correctly refuses (would
  overwrite those dirty files). That operative process has since exited (confirmed via ps + no kanban card in
  running/starting state) but the dirty files are still sitting there uncommitted - not mine to
  resolve/discard. Every shells commit so far stages ONLY its own files (git add <explicit paths>, never -A),
  so the push is what's deferred, not the work. Before G3's mesh rollout needs origin (mini must fetch
  `main`), either the operator resolves/commits the kanban WIP, or re-check whether it has by then; only then
  merge and push. Do not stash/discard those files.
