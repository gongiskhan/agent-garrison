# Shells run ledger

plan: /home/ggomes/.claude/plans/we-should-have-a-zesty-star.md (copied to docs/decisions/2026-09-03-shells-and-mesh-sessions.md)   model: Claude Sonnet 5   branch: main   head: 1bc3c25db9ae6dae4f1c9f2242c715edc0ae6873

| gate | status | commit | deploy | evidence dir | notes |
|---|---|---|---|---|---|
| G0 | done | 5af91f9021d8 | none (docs only) | evidence/shells/g0/ | ledger + gitignore negation + decision doc |
| G1 | done | 3f457a6b0715 | redeploy @ 2026-09-03T17:51Z | evidence/shells/g1/ | local transport, runtime catalog, claude-sessions lift; verified live on dev-madrid (csg transport unaffected) |
| G2 | done | d44933f2a6, 1bc3c25db9 | redeploy @ 2026-09-03T18:15Z, redeploy @ 2026-09-03T18:21Z | evidence/shells/g2/ | listers, hook install, index publish, origin guard, manifest; found+fixed TWO live bugs on dev-madrid during verification (see Open findings F-001, F-002) |
| G2 | todo | - | - | evidence/shells/g2/ | listers, hooks install, index publish, origin guard, manifest |
| G3 | todo | - | - | evidence/shells/g3/ | talk: aggregated list, live rail, direct-origin client |
| G4 | todo | - | - | evidence/shells/g4/ | talk: owned-shell workbench, external session view, new shell, styles |
| G5 | todo | - | - | evidence/shells/g5/ | cursor: stationing, quarters file sets, the mini |
| G6 | todo | - | - | evidence/shells/g6/ | csg: vs code tunnel, tether, preflight, installer, unstation |
| G7 | todo | - | - | evidence/shells/g7/ | csg install |
| G8 | todo | - | - | evidence/shells/g8/ | csg in the app |

## Mesh heads
dev-madrid 1bc3c25d @ 2026-09-03T18:21Z (local HEAD; 4 ahead / 4 behind origin/main, push deferred - see F-000) | mini n/a | csg n/a

## Resume here
G1 and G2 are done and live on dev-madrid (fitting `/health`, `/index` both healthy, real
`~/.codex/hooks.json` and `~/.gemini/settings.json` correctly carry the hooks). Start G3 per the plan
section 3: `packages/talk/src/threads.mjs` (`shellBinding`), `packages/talk/src/mesh-sessions.mjs` (new -
merge local `/index` + peer `shells.sessions` docs + thread binding), `packages/talk/src/transcript-formats.mjs`
(new - cursor/codex/gemini parsers), `packages/talk/src/router.mjs` (`GET /api/sessions`,
`GET /api/sessions/:id/stream`, join `meta.shell` into `handleThreadsList`), `src/lib/mesh/peer-proxy.ts`
(new ALLOW row for `sessions/:id/stream`), `packages/talk/ui/shell-origin.ts` (new - direct-origin client,
mirrors `resolveViewUrl`), `packages/talk/ui/sessions-rail.tsx` (Sessions section, refresh clock in
`app.tsx`). Row shape and REST contract are frozen in the decision doc section 2.2-2.4 - read those before
touching UI code. Known deliberate simplification in G2: the index only rebuilds on a periodic timer
(`index_publish_seconds`, default 10s), not on every session state change (`manager.onChange` was scoped
out to avoid invasive edits across every state-mutation point in sessions.mjs) - the rail's own poll cadence
(G3, 5s) should be enough that this is not user-visible, but note it if a "why did this take 10s to show
Working" question comes up.

Two real bugs were found DURING G2 verification (both fixed in this run, not deferred) - see F-001/F-002
below for the exact failure and fix; read them before writing any new code that touches process.env-derived
paths in a fitting, since the same class of mistake (trusting an env var name a test runner OR the runner's
own env projection can silently repoint) is easy to repeat.

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

F-001 [source: g2-live-verify] [status: fixed:d44933f2a6] `startServer()`'s new `installHooks()` call ran
  unconditionally, including inside vitest's "RemoteShellAdapter against a live server" test - which has NO
  reason to pin HOME/CODEX_HOME/GEMINI_CLI_HOME (only GARRISON_HOME). One run wrote broken hook entries
  (pointing at that test's already-deleted `/tmp/rsh-test-*` dir) into this box's REAL `~/.codex/hooks.json`
  and `~/.gemini/settings.json`. Caught by re-reading those files after the test run and noticing the
  temp-dir path. Fixed: cleaned up via `uninstallHooks()` (verified byte-identical to the pre-incident
  content - the codex `garrison-memory-hook.py` groups matched exactly), and `installHooks()` is now skipped
  outright when `process.env.VITEST` is set, matching this same file's existing `notifyChannels()`
  `underTestRunner()` discipline.

F-002 [source: g2-live-verify] [status: fixed:1bc3c25db9] Even with F-001 fixed, the FIRST real (non-test)
  redeploy still didn't touch the real `~/.codex/hooks.json` / `~/.gemini/settings.json` - it silently wrote
  into `~/.garrison/runtime-homes/{codex,gemini}` instead. Root cause: the Garrison runner projects
  `CODEX_HOME` / `GEMINI_CLI_HOME` into EVERY fitting's spawn env (not just codex-runtime/gemini-runtime),
  pointed at this node's own credential-isolated runtime home - confirmed by reading
  `/proc/<remote-shell-runtime pid>/environ` live. `install-hooks.mjs`/`uninstall-hooks.mjs` were reading
  those same var names "for testability", so they silently followed the redirect instead of the real home a
  plain interactive terminal session uses - exactly defeating the point of this feature. Fixed: both scripts
  now always resolve the REAL, unredirected `~/.codex` / `~/.gemini`; the test-only override vars are
  renamed `GARRISON_SHELLS_CODEX_HOME` / `GARRISON_SHELLS_GEMINI_HOME` so they can never again collide with
  a var name the runner itself projects. Verified live after the fix: `~/.codex/hooks.json` and
  `~/.gemini/settings.json` on dev-madrid both carry the four hook groups. The stray-but-harmless entries
  left in `~/.garrison/runtime-homes/{codex,gemini}` from before the fix were NOT removed (correctly formed,
  possibly still useful for a routed turn under that redirected home) - noted, not cleaned up.
