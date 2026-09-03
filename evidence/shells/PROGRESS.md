# Shells run ledger

plan: /home/ggomes/.claude/plans/we-should-have-a-zesty-star.md (copied to docs/decisions/2026-09-03-shells-and-mesh-sessions.md)   model: Claude Sonnet 5   branch: main   head: 46efa1db80170f49a6640dfec5aac2768a6159cf

| gate | status | commit | deploy | evidence dir | notes |
|---|---|---|---|---|---|
| G0 | done | 5af91f9021d8 | none (docs only) | evidence/shells/g0/ | ledger + gitignore negation + decision doc |
| G1 | done | 3f457a6b0715 | redeploy @ 2026-09-03T17:51Z | evidence/shells/g1/ | local transport, runtime catalog, claude-sessions lift; verified live on dev-madrid (csg transport unaffected) |
| G2 | done | d44933f2a6, 1bc3c25db9 | redeploy @ 2026-09-03T18:15Z, redeploy @ 2026-09-03T18:21Z | evidence/shells/g2/ | listers, hook install, index publish, origin guard, manifest; found+fixed TWO live bugs on dev-madrid during verification (see Open findings F-001, F-002) |
| G3-server | done | 46efa1db80 | reload @ 2026-09-03T18:36Z | evidence/shells/g3/ | mesh-sessions.mjs, shellBinding, transcript-formats.mjs, GET /api/sessions + /api/sessions/:id/stream, peer-proxy ALLOW row; live-verified streaming THIS session's own transcript through the new endpoint |
| G3-ui+G4 | done | eb9bb32d09da | reload @ 2026-09-03T19:00Z | evidence/shells/g3-ui/ | shell-origin.ts, sessions-rail.tsx Sessions section, shell-panel.tsx+shell-composer.tsx (owned shell), session-view.tsx (external), new-shell-modal.tsx, styles.css additions; 229 vitest tests green; live-verified on dev-madrid incl. this session's own transcript streaming through the rail |
| G5 | done (mini rollout pending F-000) | 82a49e35 | redeploy @ 2026-09-03T19:44Z | evidence/shells/g5/ | cursor-runtime probe fix + stationed via Muster API (found the mutateCompositionBlock state-push gap - see F-003), Quarters file_sets engine + 4 API routes + RuntimeFileSetPanel; 248 vitest tests; live create/edit/delete round trip on dev-madrid |
| G6 | doing, csg locked out (see F-004) | 66aee618 | redeploy @ 2026-09-03T21:04Z | evidence/shells/g6/ | Full tether infrastructure done + unit-tested + live-deployed: TetherManager (13 tests), normalizeTether, /tether routes, pushHostToken skip, node-identity/node-switch/peer-proxy/node-row/mesh-threads appOrigin threading, local.yml unstation, tailnet-serve-tether.mjs + shared CLI lib, wired into garrison-redeploy.sh (283 tests total, all green; /tether -> {tether:[]} confirmed live, correctly empty since the composition's csg transport has no tether block yet). host-tunnel.sh (existing, superior) supersedes an earlier, weaker supervisor script (removed) - see evidence/shells/g6/devtunnel-host-mitigation.md. csg itself is still locked out (F-004) - the composition's csg transport switch to swift-book+tether, the installer, and the preflight scripts are deliberately deferred until it answers again |
| G7 | todo | - | - | evidence/shells/g7/ | csg install |
| G8 | todo | - | - | evidence/shells/g8/ | csg in the app |

## Mesh heads
dev-madrid 66aee618 @ 2026-09-03T22:00Z (local HEAD; ahead/behind origin/main unchanged from F-000, push still deferred) | mini n/a | csg n/a (locked out, F-004)

## Resume here
G0 through G5 are done and live-verified on dev-madrid (see evidence/shells/{g0,g1,g2,g3,g3-ui,g5}/report.md
- G3-server's own report lives at evidence/shells/g3/). Cursor is stationed with a working
`cursor-local` secondary target; the Quarters file_sets engine is live (rules/skills/agents/hooks/
desktop/project-rules all render, and a real create/edit/delete round trip against
`~/.cursor/rules/*.mdc` was verified through the browser on the real machine).

**Read F-003 before touching `compositions/*/apm.yml` again, by hand or through any API**: the
Muster API's own target-write path (`upsertCompositionTarget` -> `mutateCompositionBlock`) does NOT
push to the mesh state service, so even an "official" edit can be silently reverted by the next
`up()` exactly like a hand-edit would be. `writeStandingSelections` (used by the standing swap/config
routes) DOES push correctly - that asymmetry is the trap. When in doubt, `git diff --stat
compositions/` right after a redeploy and re-push via `pushManifestToState` if anything you expected
is gone.

The mini rollout (plan section 4) is the only piece of G0-G5 not done, and it is BLOCKED on F-000
(origin/main still can't be pushed to - see below). Once that clears: push `main`, then on the mini
`ssh ggomes@goncalos-mac-mini-1 'zsh -lc "cd ~/dev/garrison && git fetch -q origin && git merge
--no-edit origin/main && npm run node:redeploy"'`, then verify `/talk` shows the mini's real Cursor
desktop sessions in the rail and `/quarters/cursor-runtime/rules` lists+autosaves the mini's actual
hand-built rules (`indy-frontend-apps-all-prs.mdc` per the plan's research appendix).

**G6 is IN PROGRESS and csg is currently LOCKED OUT - read F-004 before any further remote command
touching csg.** Done and unit-tested (no live csg needed): `TetherManager` (`lib/tether.mjs`, 11
tests), `normalizeTether` in `transports.mjs` (owner gate, mandatory localPort, reserved servePort
band), `host-credential.mjs`'s `pushHostToken: false` skip, `/tether` + `/tether/:name/repair` routes
in `server.mjs`. A real correction happened mid-gate: the plan said delete `host-tunnel.sh`, but it
turned out to be MORE capable than a fresh script written for the operator's live devtunnel-instability
ask (service-health-checked, not just process-liveness - see the removed
`devtunnel-host-supervisor.sh` in git history and `evidence/shells/g6/devtunnel-host-mitigation.md` for
why); `host-tunnel.sh` stays, diverging from the plan's literal text. Then a supervisor swap on csg
(chaining a kill with a start in one SSH command) dropped the tunnel entirely - self-sealing, this
session cannot fix it remotely. **Next action is the operator's**: on csg directly, `DEVTUNNEL_BIN=
~/.local/bin/devtunnel sh ~/.garrison/host-tunnel.sh swift-book-df6tw47.eun1 --detach`. Once csg
answers again (`devtunnel show swift-book-df6tw47.eun1 --json` -> `hostConnections: 1` from
dev-madrid, then `ssh -p 2222 -i ~/.ssh/garrison-remote-shell ggomes@127.0.0.1` through a fresh
`devtunnel connect swift-book-df6tw47.eun1`), resume with: the `compositions/default/apm.yml` csg
transport update (swift-book + `pushHostToken:false` + the `tether` block - through the Muster-safe
write path per F-003, NOT a hand-edit), `src/lib/compositions.ts` `local.yml unstation`, node-identity/
node-switch/peer-proxy/NodeSwitcher additions, then the preflight scripts, the installer, G7, G8.
Meanwhile (does not need csg): keep building the code-only pieces and their unit tests.

Known tooling limitation hit during G3-ui/G4 live verification (not a code finding): the browser-automation
`resize_window` tool in this environment does not reliably land on an exact 390x844 viewport (see the
report's "Mobile viewport" section) - screenshots at the size it did land on showed apparent text clipping
that live DOM inspection proved was NOT real (full untruncated text, correct `overflow`/`direction`/
`text-align` on every element checked). Treat any future screenshot-only "clipped text" finding at a
similarly odd viewport width with the same skepticism - verify against the DOM before filing it.

Known deliberate simplification in G2: the index only rebuilds on a periodic timer
(`index_publish_seconds`, default 10s), not on every session state change (`manager.onChange` was scoped
out to avoid invasive edits across every state-mutation point in sessions.mjs) - the rail's own poll cadence
(5s, per the plan) should be enough that this is not user-visible, but note it if a "why did this take 10s
to show Working" question comes up.

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

F-003 [source: g5-live-verify] [status: wontfix (worked around this run; the real fix is pre-existing
  architecture debt tracked as "task #31" - a three-way reconcile between the local file, the state
  service, and a concurrent editor - see the memory note sidebar-menu-and-shared-pins.md for its first
  two occurrences)] A hand-edit to `compositions/default/apm.yml` (adding cursor-runtime's dependency +
  selection + a `cursor-local` target) was silently reverted by the next `npm run node:redeploy`'s
  `up()`: `syncCompositionFromState` materialises the STATE SERVICE's copy of the manifest over the
  local file on every launch, and the only durable writer is the Muster API, which pushes to state
  with rev CAS after writing the file. Worse than the prior two occurrences of this same class of bug:
  even the "official" Muster API is not fully safe - `POST /api/muster/target` (`upsertCompositionTarget`)
  writes via `mutateCompositionBlock`, which does NOT call `pushManifestToState`, unlike
  `writeStandingSelections` (used by the standing swap/config routes), which does. So a target added
  through the real UI/API can ALSO be silently reverted by the next `up()`, indistinguishably from a
  hand-edit. Worked around this run: used `POST /api/muster/standing/swap` for the dependency+selection
  (durable), `POST /api/muster/target` for the target (gets validation, not durable), then a one-off
  `tsx` script calling `pushManifestToState` directly (not committed) to push the final file - and
  acid-tested by running `npm run node:redeploy` again and confirming `git diff --stat
  compositions/default/apm.yml` still showed the intended change. NOT fixed at the source
  (`mutateCompositionBlock` is a shared write path several other Muster features use - duty/level
  edits, config edits under some paths - fixing it is exactly the deferred task #31 work, out of scope
  for stationing one runtime). Anyone editing `targets:` via the Muster UI/API should `git diff --stat
  compositions/` after the next redeploy to confirm it held, same as any hand-edit.

F-004 [source: g6-live-verify] [status: open, needs operator action] A devtunnel-host supervisor swap
  on csg (kill the running host process, start a replacement, chained in one SSH command) dropped the
  `swift-book-df6tw47.eun1` tunnel entirely - `devtunnel show` reads `hostConnections: 0`, confirmed
  twice 15s apart, and SSH through it now times out during the banner exchange. Self-sealing: this
  session is reachable only through that tunnel, so it cannot fix this remotely. Needs the operator to
  run, ON THE CSG MACHINE DIRECTLY: `DEVTUNNEL_BIN=~/.local/bin/devtunnel sh
  ~/.garrison/host-tunnel.sh swift-book-df6tw47.eun1 --detach` (both files already staged there from
  this session). Full account, root-cause guess, and the rule for next time (never chain a kill of the
  current host with anything else in one SSH command) in
  evidence/shells/g6/devtunnel-host-mitigation.md. Everything requiring csg reachability (G7, G8,
  live-testing TetherManager/host-tunnel.sh against the real tether) is blocked until this clears.
