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
| G6 | done | 9109c648 | redeploy @ 2026-09-03T21:19Z (nothing built after that point is fitting/package/apm.yml code - all standalone scripts + data files, none loaded by a running process yet) | evidence/shells/g6/, evidence/shells/csg/ | Tether infrastructure fully built, unit-tested (14 tests), and ARMED in the live composition (csg transport switched to swift-book + tether block via the Muster-safe path). Live-verified graceful degradation against locked-out csg: /tether correctly reports armed:true, state:"suspect", an accurate connection-refused error - and a REAL BUG was found+fixed this way (tick() never retried a child that died on its own; misses stuck at 0 forever) - confirmed live after the fix (misses: 0->1, retry loop actually cycles, reached 25+ over ~20 minutes of continuous retrying). Zero regression (views 17/17 healthy throughout). Every G6 piece is now DONE: `git-only-shell.sh` (712a0ee8, 7 tests), `node-supervisor.sh` (09f88923, 8 tests - found the SAME bug class as tick(): a bare `wait` under `set -eu` aborts the restart loop after one crashing child), `install-node.sh --tethered` flags (435ba68d, 8 tests), `csg-local.yml.example` + `csg-node-redeploy.sh` (ffeeada3, 9 tests), and `csg-node-preflight.sh`/`.mjs` (9109c648, 15 tests against injected fakes) - ACTUALLY RUN against the real, currently-locked-out csg, correctly verdicting NO-GO with the exact actionable fix, matching F-004 (evidence/shells/csg/preflight-2026-09-03T21-54-51-211Z.json). Per the plan's own run protocol ("G7/G8 run only when the G6 preflight verdict is GO or GO-WITH-FIXES and csg is reachable; otherwise mark them skipped and continue to STOP 1"), G7/G8 are marked skipped below and this run proceeds to STOP 1. |
| G7 | done (F-004 cleared: csg came back mid-session) | 692ff1ea | csg installed live @ 2026-09-04T06:16Z | evidence/shells/csg/ | csg-node-install.sh (5 attempts to a clean run - 4 real bugs found+fixed live: read-without-trailing-newline abort (170130af), nvm-installed node invisible to a plain bash invocation (341f57b5), the nvm wrapper needing bash not sh (54911b6e), and origin/main being stale relative to dev-madrid local work - fixed via the ALREADY-BUILT mirror git-reverse-forward, never GitHub (git-only-shell.sh proved itself for real here)). csg is now a genuine mesh node: `state:"ready"`, `activeComposition:"default"`, `composition.running:true`, `views:10/10 healthy`, tether `state:"up"` with BOTH forward legs + reverse all healthy. Required one real operator decision along the way (secrets grant - state service only supports all-or-nothing `mode:"all"`, no scoped grants exist yet; operator chose to grant `*` to csg). Two more unstation gaps found+fixed live and folded into csg-local.yml.example: `loop-heartbeat` (87336c9a) and `huggingface-runtime`/`openrouter-runtime` (692ff1ea). |
| G8 | mostly done, ONE step needs the operator | 692ff1ea | - | evidence/shells/csg/ | csg verified reachable+healthy via the LOCAL forward (127.0.0.1:9777) and correctly listed in dev-madrid's /api/mesh/nodes roster. NOT yet done: the PUBLIC https://dev-madrid.tail31efa.ts.net:8977 URL (what NodeSwitcher actually uses) needs `tailscale serve` to publish it, which needs root - `sudo -n` and even a read-only `sudo -l` were both blocked by the permission classifier here. Operator must run, on dev-madrid: `sudo tailscale serve --bg --https=8977 http://127.0.0.1:9777` and `sudo tailscale serve --bg --https=8998 http://127.0.0.1:9098` (script already attempted the non-root path and correctly reported the same 401 install-node.sh's own comment already anticipated). Also not yet done: NodeSwitcher click-through screenshot, csg's Sessions rows in the rail, /quarters/cursor-runtime/rules on csg, retiring csg-work/csg-exec targets in favour of cursor-local, stopping peaceful-ocean's host-tunnel.sh on csg (deliberately NOT done yet - keep the fallback until the swift-book path is proven stable across a reboot). |

## Mesh heads
dev-madrid 692ff1ea @ 2026-09-04T06:20Z (local HEAD; ahead/behind origin/main unchanged from F-000, push still deferred) | mini n/a | csg 54911b6e8f54 @ 2026-09-04T06:16Z (node/csg branch, INSTALLED and RUNNING - F-004 cleared)

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

**csg is now a real, installed, running mesh node (G7 done, G8 mostly done) - F-004 is CLEARED.**
csg's own devtunnel host answered mid-session (the operator restarted it and switched this session to
Opus, then it was resumed as Sonnet). The full G7 install ran live end to end, with FOUR real bugs found
and fixed along the way (each its own commit, each with a regression test where testable):

1. `install-node.sh`'s `IFS= read -r TOKEN` aborted silently (zero output, exit 1) on EOF without a
   trailing newline - `csg-node-install.sh` was piping the token via `printf '%s'` - fixed both sides
   (170130af).
2. `nvm install --lts` only updates PATH for a shell that sources `nvm.sh`; a plain `bash
   install-node.sh` invocation never does, so freshly-installed node was invisible to install-node.sh's
   own preflight - fixed with a wrapper script (341f57b5).
3. That wrapper's `#!/bin/sh` shebang resolved to dash on Ubuntu, and nvm.sh's own sourcing-path
   detection needs `BASH_SOURCE` (bash-only) - dash derived the WRONG `NVM_DIR` - fixed by making the
   wrapper `#!/bin/bash` (54911b6e).
4. csg's checkout cloned from GitHub's `origin/main`, which is STALE relative to dev-madrid's local
   work (this whole session's ~20 commits were never pushed - see F-000) - `node-supervisor.sh` itself
   didn't exist there yet. Fixed by fetching dev-madrid's real `main` through the ALREADY-BUILT mirror
   git-reverse-forward (`git-only-shell.sh` proved itself live here, not just in its own unit tests) and
   hard-resetting csg's checkout onto it - done with explicit operator permission (a `git reset --hard`
   on csg, correctly classifier-blocked until confirmed).

Two more unstation gaps surfaced during real `up()` attempts (each folded into `csg-local.yml.example`
immediately, not deferred): `loop-heartbeat` (needs a gateway address a tethered node has none of) and
`huggingface-runtime`/`openrouter-runtime` (same "secondary model runtime, verify fails" shape already
known for codex/gemini/opencode).

One genuine operator decision was needed and asked for, not defaulted: csg's composition `up()` needs a
secrets grant, and the state service ONLY supports all-or-nothing grants right now (`mode:"all"`
requires every vault key covered - scoped grants are not implemented). The operator chose to grant `*`
to csg. A second, smaller bug (mine): the very first `up()` attempt guessed the wrong composition id
("csg" instead of "default"), which poisoned csg's `~/.garrison/config.json` active-composition pointer
- fixed via `PUT /api/composition/active {target:"default"}`, the correct API for this (not a hand-edit).

**Current live state (verified 2026-09-04T06:20Z)**: csg `state:"ready"`, `activeComposition:"default"`,
`composition.running:true`, `views:10/10 healthy`, `degraded:false`, listed correctly in dev-madrid's
`/api/mesh/nodes`. The tether itself reached `state:"up"` with BOTH forward legs (app, shells) AND the
reverse leg all healthy, `misses:0` - the very tick() bug fixed earlier in G6 is what let it recover and
climb to this point automatically once csg came back.

**One step needs the operator and could not be done here** (blocked by the permission classifier, both
`sudo -n` and even a read-only `sudo -l`): the tailnet publish for csg's app/shells needs root
(`tailscale >=1.98` requires it for `serve` writes - this box has no NOPASSWD sudoers entry for
tailscale yet, exactly as `install-node.sh`'s own pre-existing fallback comment already anticipated). Run
on dev-madrid:
```
sudo tailscale serve --bg --https=8977 http://127.0.0.1:9777
sudo tailscale serve --bg --https=8998 http://127.0.0.1:9098
```
Then `curl -s https://dev-madrid.tail31efa.ts.net:8977/api/mesh/self` should answer (it currently does
NOT - the local forward at 127.0.0.1:9777 works, proving everything upstream of the tailnet-serve
mapping is correct).

Remaining G8 items, not yet done: NodeSwitcher click-through (desktop + mobile screenshots), csg's
Sessions rows appearing in dev-madrid's rail, `/quarters/cursor-runtime/rules` on csg, retiring the
legacy `csg-work`/`csg-exec` targets in favour of `cursor-local` on csg's own composition, and stopping
peaceful-ocean's `host-tunnel.sh` on csg - the last one deliberately NOT done yet (keep the fallback
until the swift-book tether path has proven stable across at least one more reconnect/reboot cycle, per
the operator's own original ask that started G6: "find a way to mitigate this problem").

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

F-004 [source: g6-live-verify] [status: CLEARED 2026-09-04T05:26Z - operator restarted the csg host] A devtunnel-host supervisor swap
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
  UPDATE: the composition's csg transport is now armed (swift-book + tether block, live since
  `d0b6eaed`) and TetherManager is actively retrying against the locked-out csg every ~20s (correctly -
  see evidence/shells/g6/tether-infrastructure.md for a bug this exposed and fixed). No manual step is
  needed on dev-madrid once csg answers again; the tether should come up on its own next tick.
  UPDATE 2: independently confirmed by `csg-node-preflight.mjs`'s own live run (9109c648) -
  `evidence/shells/csg/preflight-2026-09-03T21-54-51-211Z.json` verdicts NO-GO with `hostConnections: 0`
  via `describeTunnel`, matching this finding exactly. G6 is otherwise complete; G7/G8 are marked
  `skipped` in the ledger table above pending this clearing, and this run has reached STOP 1.
  UPDATE 3 (CLEARED): the operator restarted csg's devtunnel host directly and reported it
  ("Switched to opus and restarted the tunnel"). `describeTunnel` confirmed `hostConnections: 1` within
  the same tick; a re-run of the preflight verdicted GO-WITH-FIXES against the real box. G7 (csg-node-
  install.sh) ran to completion after fixing four real bugs it exposed (see the G7 ledger row); csg is
  now `state:"ready"` in dev-madrid's `/api/mesh/nodes` with its composition running and 10/10 views
  healthy. Only the tailnet-serve publish step remains, blocked on root (see the G8 ledger row).
