# Shells run ledger

plan: /home/ggomes/.claude/plans/we-should-have-a-zesty-star.md (copied to docs/decisions/2026-09-03-shells-and-mesh-sessions.md)   model: Claude Sonnet 5   branch: main   head: 46efa1db80170f49a6640dfec5aac2768a6159cf

| gate | status | commit | deploy | evidence dir | notes |
|---|---|---|---|---|---|
| G0 | done | 5af91f9021d8 | none (docs only) | evidence/shells/g0/ | ledger + gitignore negation + decision doc |
| G1 | done | 3f457a6b0715 | redeploy @ 2026-09-03T17:51Z | evidence/shells/g1/ | local transport, runtime catalog, claude-sessions lift; verified live on dev-madrid (csg transport unaffected) |
| G2 | done | d44933f2a6, 1bc3c25db9 | redeploy @ 2026-09-03T18:15Z, redeploy @ 2026-09-03T18:21Z | evidence/shells/g2/ | listers, hook install, index publish, origin guard, manifest; found+fixed TWO live bugs on dev-madrid during verification (see Open findings F-001, F-002) |
| G3-server | done | 46efa1db80 | reload @ 2026-09-03T18:36Z | evidence/shells/g3/ | mesh-sessions.mjs, shellBinding, transcript-formats.mjs, GET /api/sessions + /api/sessions/:id/stream, peer-proxy ALLOW row; live-verified streaming THIS session's own transcript through the new endpoint |
| G3-ui+G4 | done | eb9bb32d09da | reload @ 2026-09-03T19:00Z | evidence/shells/g3-ui/ | shell-origin.ts, sessions-rail.tsx Sessions section, shell-panel.tsx+shell-composer.tsx (owned shell), session-view.tsx (external), new-shell-modal.tsx, styles.css additions; 229 vitest tests green; live-verified on dev-madrid incl. this session's own transcript streaming through the rail |
| G5 | todo | - | - | evidence/shells/g5/ | cursor: stationing, quarters file sets, the mini |
| G6 | todo | - | - | evidence/shells/g6/ | csg: vs code tunnel, tether, preflight, installer, unstation |
| G7 | todo | - | - | evidence/shells/g7/ | csg install |
| G8 | todo | - | - | evidence/shells/g8/ | csg in the app |

## Mesh heads
dev-madrid eb9bb32d @ 2026-09-03T19:12Z (local HEAD; ahead/behind origin/main unchanged from F-000, push still deferred) | mini n/a | csg n/a

## Resume here
G0-G3-server, G3-ui, and G4 are all done and live-verified on dev-madrid, including a real browser pass
(see evidence/shells/g3-ui/report.md): the Sessions rail section, the owned-shell panel, the external
session view (proved live by streaming THIS session's own transcript through it), the New shell modal
(Cursor correctly greyed out - no cursor-agent on dev-madrid), and the Show ended toggle all work end to
end against `https://dev-madrid.tail31efa.ts.net`.

Next: G5 per the plan section 3 - station `cursor-runtime` in `compositions/default/apm.yml`
(`fittings/seed/cursor-runtime/scripts/bridge.mjs` needs its degraded-probe fix FIRST - absent cursor-agent
must exit 0 with a "degraded" note, or `verify()` failing aborts `up()` for the whole composition per
CLAUDE.md's runner rule), then the Quarters `file_sets` descriptor (`src/lib/metadata.ts`,
`src/lib/quarters-runtimes.ts`, the two new API routes, `RuntimeFileSetPanel.tsx`) so `~/.cursor/{rules,
skills, agents, hooks.json, desktop settings, project rules}` become read/write Quarters surfaces, then
roll out to the mini (section 4: push `main`, `ssh` + `git merge --no-edit origin/main` +
`npm run node:redeploy` on `goncalos-mac-mini-1`, verify its Cursor desktop sessions appear in the rail).
Read the decision doc section 2 (contracts) and G5's file list before touching code - the Cursor probe
change is load-bearing for every node that does NOT have cursor-agent (dev-madrid included today).

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
