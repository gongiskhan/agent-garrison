# Shells, mesh session list, Cursor everywhere, csg as a node

**Date:** 2026-09-03
**Status:** Approved, execution in progress. This file is a direct copy of the approved plan
(originally written at `~/.claude/plans/we-should-have-a-zesty-star.md`), kept here so any Garrison
session working on this repo can find it. Grow this file with per-gate notes as the run proceeds
(per section 7 of the plan below); do not silently rewrite the approved plan text above the notes.

## Gate log

G0-G3-server: see `evidence/shells/{g0,g1,g2,g3}/report.md` and the ledger at
`evidence/shells/PROGRESS.md` for the full per-gate record, including two real live-verification bugs
found and fixed during G2 (F-001, F-002 in the ledger).

**G3-ui + G4 (2026-09-03).** Built together as one changeset: `shell-origin.ts` (the direct-origin
client - `resolveShellOrigin`, `shellFetch`, `shellSocketUrl`, `errorCopy`), the rail's Sessions section
in `sessions-rail.tsx` (node sub-heads, runtime/project/status chips, Show ended toggle,
`visibleSessionRows` as the shared dedupe filter), and the G4 slice: `session-view.tsx`
(`ExternalSessionView`, reusing `@garrison/claude-chat`'s `SessionStream` for the transcript body),
`new-shell-modal.tsx`, and `styles.css` additions for all of it. **One deliberate deviation from
section 3's literal text**: rather than adding `mode="shell"` to `remote-shell-workbench.tsx`, the owned-
shell view is a new sibling component, `shell-panel.tsx` (`ShellPanel`) + `shell-composer.tsx`, reusing
the same deck CSS classes. `remote-shell-workbench.tsx` carries seam/ledger/delegate machinery for the
OLDER remote-shell thread shape that a second mode would have had to thread through or dodge for no
benefit; a sibling component carries zero risk to that existing surface while sharing its visual language
exactly. Live-verified on dev-madrid, including streaming this very Claude Code session's own transcript
through the new `ExternalSessionView` (see `evidence/shells/g3-ui/report.md` for the full browser-
verification log, including a browser-automation viewport-resize tooling limitation that produced a
misleading screenshot the live DOM disproved).

**G5 (2026-09-03).** `bridge.mjs`'s probe now returns `{level, reason} | null` (absent vs
unauthenticated) so a node with no `cursor-agent` degrades `up()` instead of failing it -
`GARRISON_REQUIRE_CURSOR=1` restores the strict behavior for a node that must run Cursor. Stationed
`cursor-runtime` (dependency + selection + a `cursor-local` secondary target) in
`compositions/default/apm.yml`. **Found a real trap doing this, worth reading before touching any
composition manifest again**: a hand-edit is silently reverted by the next `up()`
(`syncCompositionFromState` overwrites the local file from the mesh state service on every launch),
and the "official" Muster target-write API is not fully immune to the same bug either
(`mutateCompositionBlock` skips the state push that `writeStandingSelections` does) - see ledger
finding F-003 for the exact mechanism and the workaround (Muster API for validated writes, a one-off
`pushManifestToState` call for durability, acid-tested with a second redeploy). Then built the
Quarters `file_sets` primitive end to end: schema (`src/lib/metadata.ts`/`types.ts`), the engine
(`src/lib/quarters-runtimes.ts` - list/read/write/create/delete, restricted-glob containment,
realpath symlink checks, `write:"merge"` for json, platform/scope gating), four API routes, and
`RuntimeFileSetPanel.tsx`. cursor-runtime's descriptor now declares six sets (rules, skills, agents,
hooks merge-write, desktop darwin-only, project-rules project-scoped). Live-verified on dev-madrid
with a real browser create -> autosave -> delete round trip against `~/.cursor/rules/e2e-check.mdc`
on the actual filesystem (see `evidence/shells/g5/report.md`). The mini rollout (Cursor desktop
sessions + a live `~/.cursor/rules` autosave there) did not run this pass - blocked on F-000 (push to
origin/main still deferred).

---

# Shells + mesh session list + Cursor everywhere + csg as a node

Executable plan. Implementer: Sonnet 5. Review: Fable 5.1 / Opus 5 (operator picks). E2E: Opus 5 with
claude-in-chrome. Section 9 is the run protocol with the STOP points; section 10 is the ledger format. Read
section 2 (contracts) before touching any file. No em dashes anywhere in code or docs. No emoji in UI.

## 1. Context

Garrison drives orchestrated work (Conversations, Kanban) but the operator still runs plain CLI sessions
(`claude`, `codex`, `cursor-agent`, `gemini`) in terminals and Cursor desktop on the mini and on the csg VM,
and Garrison cannot see them. Goal: Garrison becomes the one place to SEE every session on every node
(active or active in the last 5 days), to WORK with them (attach to a tmux-backed shell, read a live
transcript, resume, type into it from a phone), and to START new plain sessions on any node for any CLI
runtime. This is the interim "shell" path until everything runs through the orchestrator; it is also what
lets the operator stop using Cursor desktop. In the same run: Cursor gets first-class treatment (stationed
runtime, Quarters surface for `~/.cursor` rules/skills/hooks/desktop settings, sessions on the mini), the csg
transport moves onto the VS Code tunnel, and csg becomes a full (tethered) Garrison node.

Operator decisions (2026-09-03): (1) csg path in = the VS Code tunnel `swift-book-df6tw47.eun1` only, port
2222 already registered on it; retire `peaceful-ocean-zcx3mqx.eun1` + `host-tunnel.sh`; fall back to
peaceful-ocean (never a NEW tunnel) if the code-tunnel host drops 2222 with no VS Code client attached.
(2) csg = FULL node in this plan, done last, behind a go/no-go preflight. (3) Cursor desktop sessions:
list + read live + try `cursor-agent --resume <composerId>`, honest failure banner, "new agent in this
project" fallback. (4) Mesh scope: every node, aggregated through the state service; attach/new-shell talk to
the owning node's fitting directly.

State of the world tonight: csg is OFF (both tunnels `hostConnections: 0`); the mini is up (cursor-agent at
`~/.local/bin`, Cursor desktop sessions present, `sqlite3` present); dev-madrid has no `cursor-agent`, no
`sqlite3`, Node 20.19 under the prod unit. The checkout is on `main` (direct pushes sanctioned; NEVER create a
branch).

## 2. Architecture and contracts (both sides implement exactly this)

### 2.1 Components

- **Shells substrate = fitting `remote-shell-runtime`** (id unchanged; display name "Shells" in
  `data/library.json`; own-port 8098, serve port 8498). Gains a `local` transport (this machine, tmux on
  `$GARRISON_HOME/tmux/shells.sock`), a runtime catalog (claude/codex/cursor/gemini/shell), local session
  LISTERS, status sources, an index publisher to the state service, a CORS/Origin guard, and the csg tether.
  Everything above the `#exec` seam in `lib/sessions.mjs` stays transport-agnostic.
- **Conversations (`packages/talk`)** renders the aggregated list (local threads + every node's index),
  owned-shell workbench (deck + xterm + composer), external-session view (live transcript + actions), and the
  New shell flow. The browser reaches the owning node's fitting DIRECTLY for REST + WS (Next cannot upgrade
  WebSockets; the `/remote-shell/io` relay only exists in the legacy own-port host).
- **State service** carries one config doc per node: namespace `shells.sessions`, scope `node:<name>`
  (pattern: `packages/talk/src/thread-registry.mjs`). The `sessions` TABLE is NOT used (the git commit guard
  reads it).
- **Quarters** generic runtime tier gains `file_sets` (directory-of-markdown / json surfaces) so
  `cursor-runtime`'s descriptor can expose rules, skills, agents, hooks.json, desktop settings, project rules.
- **csg** = tethered node: one `ssh -N` child from dev-madrid over the VS Code tunnel carrying `-R` (state
  service, dev-madrid sshd for git) and `-L` (csg app + shells), published on dev-madrid's tailnet host via
  `tailscale serve`; csg's `node.json` carries explicit `appOrigin`/`shellOrigin`.

### 2.2 Session row (`Row`), produced by the fitting, consumed by talk

```
{
  id: "shell:<transport>:<tmuxSession>" | "<runtime>:<sessionRef>",
  node, runtime: "claude"|"codex"|"cursor"|"gemini"|"shell",
  kind: "shell"|"cli"|"desktop"|"bg",
  cwd, project,                 // project = basename(cwd) or the slug tail
  title,
  status: "working"|"idle"|"ended"|"unknown",
  statusSource: "registry"|"hooks"|"pane"|"transcript"|"none",
  startedAt, lastActivityAt,    // ISO or null
  resumable, attachable,        // booleans (resumable also requires the CLI to be available on that node)
  resumeRef,                    // uuid | chatId | {index, latest} (gemini)
  resumeCommand,                // "cd <cwd> && claude --resume <id>" etc, null for shell rows
  shell?: { transport, tmuxSession, label, sessionId },   // owned shells only (sessionId = fitting session id)
  threadId?,                    // owned shells: the talk thread id when known
  claimedBy?: { kind: "thread"|"card", id },              // already owned by a Conversation/card
  transcript?: { format: "claude-jsonl"|"codex-rollout"|"cursor-agent-jsonl"|"gemini-chat-jsonl", path }
}
```
Doc body: `{ node, shellOrigin: { loopback, public }, updatedAt, rows }` capped at 300 rows within
`session_window_days` (default 5). `shellOrigin.public` = `node.json.shellOrigin` override when present, else
`https://<tailnetHost>:<8400 + port % 1000>`, else null. `GET /index` on the fitting returns the same body.

### 2.3 Fitting REST (browser calls it cross-origin; CORS per 2.6)

- `GET /health` -> `{ ok, port, pid, node, shellOrigin, transports, tunnels, tether, sessions, local: { enabled, tmux } }`
- `GET /transports` -> `{ transports: [{ name, label, kind: "local"|"ssh"|"devtunnel", tunnel, tmuxSession, cwd, projectsRoot, agentCommand, routingTarget, forwards, tether }] }`
- `GET /runtimes?transport=<name>` -> `{ runtimes: [{ id, label, bin, available, path, resumable, attachable, checkedAt }] }` (login-shell `command -v` probe, cached 5 min per transport)
- `GET /projects?transport=<name>` -> unchanged `{ projects: [{ name, path, sessions }] }` (root = transport `projectsRoot`)
- `GET /index` -> the doc body above
- `GET /sessions` -> `{ sessions: [summary] }`; summary gains `kind, runtime, resumeRef, resumeCommand, threadId, node`
- `POST /sessions { transport, runtime?, cwd?, resume?, attach?, label?, tmuxSession?, allocate?, recycle? }` -> `{ session }`.
  `runtime` picks the catalog argv; `resume` = runtime session ref (validated by the runtime's `refPattern`, 400 otherwise);
  `attach: true` only with `runtime: "claude"` types `claude attach <id>`; no `runtime` keeps today's `transport.agentCommand`;
  `runtime: "shell"` types nothing.
- `POST /sessions/:id/input { text }`, `POST /sessions/:id/keys { keys }` (tmux key names), `GET /sessions/:id/screen?lines=N`,
  `POST /sessions/:id/detach`, `DELETE /sessions/:id?kill=1`, `POST /sessions/:id/turn`, `GET /sessions/:id/turns/:turnId` unchanged.
- `GET /tether`, `POST /tether/:transport/repair` (G6).
- `WS /io` unchanged (dev-env protocol: `init{sessionId,cols,rows}` -> `init_ack` -> replay -> binary frames; `{type:resize|ping|stdin}`; close = detach).
- `OPTIONS *` -> 204 with CORS headers. `/exec` and `/agent-turns` refuse any request carrying an `Origin` header (loopback tools only).

### 2.4 Talk contracts

- Owned-shell thread: `{ id: "shell-<node>-<transport>-<tmuxSession>", source: "shell", context: { shell: { node, transport, tmuxSession, cwd, runtime, label, sessionId, shellOrigin } } }`
  whitelisted at read by `shellBinding(thread)` (sibling of `remoteShellBinding`, never overload `remoteShell`). Legacy
  `remote-shell-*` threads keep their existing path untouched.
- `GET /api/sessions` -> `{ self, nodes: [{ node, accentColor, status, lastSeenAt, shellOrigin }], rows }` (rows carry `node, nodeAccent, nodeStatus, shellOrigin, threadId?, boundTo?`).
- `GET /api/sessions/:id/stream` -> SSE frames `{type: init|events|snapshot|end}` exactly like `/api/session-stream`, path resolved server-side from the local index (never a client path).
  Peer: `/api/mesh/nodes/<node>/sessions/<id>/stream` via one new peer-proxy ALLOW row `{ shape: ["sessions", ID, "stream"], methods: ["GET"], upstream: "app", sse: true }`.
- `GET /api/threads` folds a FOURTH liveness source: `meta.shell` joined from the index (`status === "working"` -> `runningSince`).
- Rail refresh: sessions poll 5 s, thread list 10 s, mesh-threads 30 s; all skipped when hidden or busy; immediate on `visibilitychange`/`focus`.

### 2.5 Node identity and transport config

`~/.garrison/node.json`: `{ id, name, accent, tailnetHost (string|null), createdAt, tethered?: true, tetherHost?, appOrigin?, shellOrigin? }`.
`src/lib/node-identity.ts` parses the new fields (https origins only, else null). The roster (`/api/mesh/nodes`,
`node-row.ts`) exposes `appOrigin` from the beat's `health.node.appOrigin` (no state-service schema change:
`hello()` stores the whole `/api/mesh/self` body). `nodeAppOrigin()` / `peerAppBase()` prefer `appOrigin` over
`https://<tailnetHost>`; `NodeSwitcher` enables a peer that has either.

Transport JSON (composition `transports` config) additions: `kind` (derived), `projectsRoot` (default `~/dev`),
`loginShell` (bash|zsh), `via.devtunnel.pushHostToken` (default true; csg sets false), and
```
"tether": {
  "owner": "dev-madrid", "node": "csg",
  "reverseForwards": [ {"name":"state","remotePort":8460,"localPort":8460}, {"name":"git","remotePort":2200,"localPort":22} ],
  "forwards": [ {"name":"app","remotePort":8777,"localPort":9777,"publish":{"servePort":8977}},
                {"name":"shells","remotePort":8098,"localPort":9098,"publish":{"servePort":8998}} ],
  "onUp": "$HOME/.garrison/node-supervisor.sh ensure"
}
```
Rules: tether armed only when `GARRISON_NODE_NAME === owner`; `localPort` mandatory on tether forwards;
`publish.servePort` outside 8400..8499 and not 443/8443-8445/8860; `onUp` is a fixed string run via `bash -lc`.
The legacy per-port `forwards[]` (openai composition) stays on `ForwardManager`; reverse forwards live ONLY in the tether.

### 2.6 Origin guard (fitting)

`isTrustedHost` ported verbatim from `src/lib/mesh/peer-auth.ts` (loopback, RFC1918, 100.64/10, IPv6 ULA/link-local,
`*.ts.net`). Reject when the `Host` hostname is untrusted (rebinding). When `Origin` is present, allow when its hostname
is trusted (deliberately broader than same-origin: node A's page calls node B's fitting) and answer
`Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, methods `GET, POST, DELETE, OPTIONS`, headers `content-type`,
max-age 600. Same verdict on the WS upgrade (403 + destroy). This fitting is as open on the tailnet as the shell and
dev-env already are; the tailnet is the trust boundary.

### 2.7 Status precedence (never lie)

1. Runtime-native: Claude registry `status` (busy -> working, idle|shell -> idle); hook events in
   `~/.garrison/events.jsonl` (`agent-start` newer than `agent-stop` and < 15 min -> working; `agent-stop` -> idle;
   `session-end` -> ended), matched by `session_id`, then `runtime + cwd`.
2. Pane evidence, owned shells only: `pane_current_command` not a bare shell AND output in the last 20 s -> working;
   not a shell, quiet -> idle; bare shell -> idle; unhealthy tunnel -> unknown.
3. Transcript mtime (external, no hooks): `now - lastActivityAt <= 20 s` -> working, else unknown.
Never `working` from liveness alone; `ended` only with evidence (Claude history with no registry entry, or a
`session-end` event).

## 3. Gates (implementation)

Every gate: vitest suites named below + `npm run typecheck` + `npm run lint` green; commit; restart per the
discipline (fitting/packages/apm.yml change -> `npm run node:redeploy`; app-only -> `npm run node:reload`);
evidence under `evidence/shells/<gate>/` taken against `https://dev-madrid.tail31efa.ts.net` (never localhost);
ledger row updated (section 10). Tests import fitting `.mjs` with `// @ts-ignore` (pattern:
`tests/remote-shell-multisession.test.ts`) or an ambient shim `tests/shells-mjs.d.ts` (pattern: `tests/mesh-mjs.d.ts`).

### G0. Ledger and decision record

- `.gitignore`: add `!evidence/shells/` next to the `!evidence/garrison-app/` negation (media excludes copied from that block).
- Create `evidence/shells/PROGRESS.md` (section 10 format) and `docs/decisions/2026-09-03-shells-and-mesh-sessions.md`
  (context + the contracts of section 2; grow it per gate).
- Commit. No deploy.

### G1. Substrate: local transport, runtime catalog, claude-sessions lift

Files (fitting root `FIT = fittings/seed/remote-shell-runtime`):

- `FIT/lib/transports.mjs`
  - `localTransport(env)`: `{ name:"local", kind:"local", label: <node name or hostname>, ssh:null, via:null, tmuxSession:"local", cwd:"~", eventsFile:"~/.garrison/events.jsonl", agentCommand:null, agentResumeCommand:null, routingTarget:null, forwards:[], tether:null, projectsRoot: env.GARRISON_REMOTESHELLRUNTIME_LOCAL_PROJECTS_ROOT || "~/dev", loginShell: basename(env.GARRISON_REMOTESHELLRUNTIME_LOCAL_LOGIN_SHELL || env.SHELL) whitelisted to bash|zsh else "bash", local: { socket: join(garrisonHome(),"tmux","shells.sock"), conf: join(HERE,"tmux.shells.conf") }, stateDirExpr: shellQuote(join(garrisonHome(),"shells")) }`.
  - `loadTransports(env)`: synthesise `local` when `GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS !== "false"` and `tmux -V` succeeds (memoised); ssh transports get `kind`, `stateDirExpr: '"$HOME/.garrison"'`, `loginShell: "bash"`, `projectsRoot`.
  - `localExec(transport, command, {timeoutMs, input, onStdout, onSpawn})`: same promise shape as `sshExec`; `/bin/sh -c` with prelude `tmux() { command tmux -S '<socket>' -f '<conf>' "$@"; }; ` so every `tmux ...` in the existing command strings (incl. `$(tmux display-message ...)`) hits the dedicated socket; env = process.env + PATH augmented (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), `LANG/LC_CTYPE` defaulted, `TERM=xterm-256color`, `TMUX`, `TMUX_PANE`, `CAPTURE_TOKEN` deleted; `mkdir -p` the socket dir.
  - `transportExec(transport, command, opts)` dispatches on `kind`; export it; `remote-files.mjs` switches to it (one line).
  - `attachSpawnSpec(transport, tmuxSession)` (ssh: today's argv; local: `["tmux","-S",socket,"-f",conf,"attach-session","-t",name]` with the sanitised env) and `eventsTailSpec(transport)` (ssh: today's `touch; tail -n 0 -F`; local: fs `mkdir/touch` then `["tail","-n","0","-F",<expanded eventsFile>]`). Export `expandHome`.
- `FIT/lib/tmux.shells.conf` (new): copy of `fittings/seed/dev-env/scripts/tmux.garrison.conf` minus pbcopy bindings; keep `status off`, `history-limit 50000`, `escape-time 0`, `default-terminal xterm-256color`, `mouse on`, `destroy-unattached off`; no `window-size latest`.
- `FIT/lib/sessions.mjs`: constructor default `exec = transportExec`; `ensureAttached` uses `attachSpawnSpec` via `this.ptySpawn(spec.file, spec.argv, {name:"xterm-256color", cols, rows, env: spec.env})`; `#ensureEventsWatcher` uses `eventsTailSpec` via injectable `this.spawnFn`; replace the three `"$HOME/.garrison"` literals (`#ensureRemoteHook`, `#pulseCommand`, `#teardownPipe`) with `t.stateDirExpr` (byte-identical for ssh); `#remoteCommand` uses `transport.loginShell`; `listProjects` uses `transport.projectsRoot`; `summary()` adds `kind, runtime, resumeRef, resumeCommand, threadId, node`; add `session.lastOutputAt = Date.now()` in the attach `onData`.
- `FIT/lib/runtimes.mjs` (new): `RUNTIMES` = claude (`newArgv ["claude"]`, `resumeArgv ["claude","--resume",ref]`, `attachArgv ["claude","attach",ref]`, `refPattern /^[0-9a-f-]{8,64}$/i`, `statusSource "registry"`), codex (`["codex"]`, `["codex","resume",ref]`, uuid pattern), cursor (`["cursor-agent"]`, `["cursor-agent","--resume",ref]`, `/^[A-Za-z0-9_-]{6,80}$/`), gemini (`["gemini"]`, `["gemini","--resume", ref.latest ? "latest" : String(ref.index)]`, accepts bare "latest"/integer), shell (nothing). `probeRuntimes(execFn, transport)`: ONE login-shell command `for b in claude codex cursor-agent gemini; do p=$(command -v $b 2>/dev/null); printf '%s\t%s\n' "$b" "${p:-}"; done`. `commandLine(argv)` via `shellQuote` (move `shellQuote` to `FIT/lib/shell-quote.mjs`, imported by both).
- `FIT/lib/sessions.mjs` `start(transportName, {..., runtime=null, resume=null, attach=false})`: validate; `typed = runtime ? (attach ? attachArgv : resume ? resumeArgv : newArgv) : (transport.agentCommand ? [transport.agentCommand] : null)`; type only when the pane is a bare shell (existing check); record `runtime` (default basename(agentCommand) or "shell"), `resumeRef`, `resumeCommand = runtime && resume ? commandLine(resumeArgv(resume)) : null`, `runtimeBin`; `#stormRecover` uses `session.resumeCommand ?? t.agentResumeCommand` and `session.runtimeBin`; the exec lane keeps its `cursor-agent` guard; `persist/restore` carry the new fields.
- `FIT/scripts/server.mjs`: `GET /transports` adds `kind, projectsRoot, tether`; `/health` adds `local`; `POST /sessions` passes `runtime, resume, attach`; `GET /runtimes?transport=`.
- Lift `fittings/seed/dev-env/scripts/claude-sessions.mjs` (+ `.d.mts`) to `packages/claude-pty/src/claude-sessions.mjs` (git mv; log prefix `[claude-sessions]`); export `readLiveRegistry, listHistory, isInternalCwd` from `packages/claude-pty/src/index.mjs`; dev-env's file becomes a re-export; add `listBackgroundAgents({spawnFn, timeoutMs=5000})` = `claude agents --json` filtered to `kind === "background"`, never throws.

Tests: `tests/remote-shell-local-transport.test.ts` (fixture `tests/fixtures/shells/fake-bin/tmux` sh script echoing argv + `${TMUX:-unset}`; prelude injects `-S/-f`; `SessionManager` with injected `exec/ptySpawn/spawnFn` issues the same tmux strings as ssh, attaches with `["-S",...,"attach-session","-t","alpha"]`, tails the real `~/.garrison/events.jsonl`, pulse file under `<GARRISON_HOME>/shells/`), `tests/remote-shell-runtimes.test.ts` (argv builders; `runtime:"codex", resume:<uuid>` types `'codex' 'resume' '<uuid>'`; `runtime:"claude", attach:true`; no runtime keeps `cursor-agent`; bad resume -> 400), existing `tests/remote-shell-storm.test.ts`, `remote-shell-multisession.test.ts`, `remote-shell-runtime.test.ts`, `remote-shell-exec-lane.test.ts`, `dev-env-claude-sessions.test.ts`, `dev-env.test.ts` stay green. Guard test: grep `sessions.mjs` for `tmux` not at command position (`/(^|[;&|(]\s*|\$\()tmux\b/`).

Verify: the suites above; `node fittings/seed/dev-env/scripts/probe.mjs --probe`; `npm run node:redeploy`; live: `curl -s 127.0.0.1:8098/transports | jq '.transports[]|{name,kind}'` shows `local`; `curl -s -X POST 127.0.0.1:8098/sessions -d '{"transport":"local","runtime":"shell","cwd":"~/dev/garrison","allocate":true}' -H 'content-type: application/json'` creates a tmux session visible in `tmux -S ~/.garrison/tmux/shells.sock ls`. Evidence: outputs + the `tmux ls` line.

### G2. Listers, hooks, index publication, origin guard, manifest

- `FIT/lib/listers/claude.mjs`: live registry rows (`kind:"cli"`, status from registry, `statusSource:"registry"`, title = registry `name` || transcript title, `resumeRef = sessionId`, `transcript.path = join(claudeProjectDirForCwd(cwd), sessionId + ".jsonl")`), history rows not live -> `status:"ended"`, `listBackgroundAgents()` -> `kind:"bg"`, `attachable:true`.
- `FIT/lib/listers/codex.mjs`: homes = dedupe(`~/.codex`, `$CODEX_HOME`, `$GARRISON_HOME/runtime-homes/codex`, `$GARRISON_HOME/marathon/codex-home`); `session_index.jsonl` -> titles; walk `sessions/YYYY/MM/DD` newest-first (copy `sessionDayDirs` from `fittings/seed/codex-runtime/lib/codex-adapter.mjs:156`, `dayLimit = windowDays + 1`); first line `session_meta`; skip `thread_source === "subagent"` / `payload.source?.subagent`; `id = payload.id`, `cwd`, `startedAt = payload.timestamp`, `lastActivityAt = mtime`, `transcript.format "codex-rollout"`, `resumeRef = id`.
- `FIT/lib/listers/cursor.mjs`: root `~/.cursor` (override `GARRISON_CURSOR_HOME`); `projects/<slug>/agent-transcripts/<id>/<id>.jsonl` -> one row per id; `chats/<ws>/<id>/meta.json` gives `cwd/createdAtMs/updatedAtMs` and `kind:"cli"`; ids without a chats entry -> `kind:"desktop"`, cwd matched by slug (`cwd.replace(/[/.]/g,"-")`) against known cwds (`~/dev/*`, `~/Projects/*`, other listers' cwds), else `project` = last slug segment; title from `sqlite3 -json <state.vscdb> "select key,value from cursorDiskKV where key like 'composerData:%'"` when `sqlite3` exists (60 s cache, 5 s timeout, never throws), else first `user_query` text; `resumeRef = id`; `resumable` = cursor-agent available on `local`; `transcript.format "cursor-agent-jsonl"`.
- `FIT/lib/listers/gemini.mjs`: homes = dedupe(`~/.gemini`, `$GEMINI_CLI_HOME`, `$GARRISON_HOME/runtime-homes/gemini`); `projects.json {projects:{<cwd>:<name>}}`; `tmp/<name>/chats/session-*.jsonl` first line `{sessionId, startTime, lastUpdated}`; `resumeRef = {index: 1-based by startTime asc within cwd, latest}`; `transcript.format "gemini-chat-jsonl"`.
- `FIT/lib/session-index.mjs`: `buildIndex({manager, transports, windowDays, homes, now})`: owned shells first (`id "shell:<t>:<tmux>"`, status per 2.7 pane rule), external rows from the four listers minus `isInternalCwd(cwd)` and minus duplicates of an owned pane (same runtime + cwd; Claude by sessionId), status via `resolveStatus` (2.7), `claimedBy` from thread files (`$GARRISON_HOME/web-channel/threads/*.json`: `sessionIds[]`, `claudeSessionId`, `context.shell`, `context.remoteShell`; mtime-cached) and cards (`stateClient.listCards()` every 60 s; skip when unenrolled), `resumeCommand` = `cd <cwd> && <commandLine(resumeArgv(ref))>` (attach for bg), sort `lastActivityAt` desc, cap 300. Budget: < 2 s in the test (measured).
- `FIT/lib/sessions.mjs` `REMOTE_EVENT_HOOK`: second positional `runtime="${2:-}"` written as `"runtime"` in the JSON line (csg keeps calling with one arg).
- `FIT/scripts/install-hooks.mjs` (new; env-driven paths `HOME`, `GARRISON_HOME`, `GARRISON_CURSOR_HOME`, `GARRISON_CODEX_HOME`, `GARRISON_GEMINI_HOME`): write `$GARRISON_HOME/shells/agent-event-hook.sh` (same bytes as `REMOTE_EVENT_HOOK`, 755); Cursor `~/.cursor/hooks.json` (`stop` -> `<hook> agent-stop cursor`, `beforeSubmitPrompt` -> `<hook> agent-start cursor`, matched by exact `command`, `version:1` kept, create the file when `~/.cursor` exists); Codex `~/.codex/hooks.json` (Claude-shaped groups `UserPromptSubmit`/`Stop`/`SessionStart`/`SessionEnd`, `{matcher:"", hooks:[{type:"command", command, timeout:5}]}`, NO `_garrison` tag, NEVER write `[hooks.state]` trust hashes; print the one-time trust notice); Gemini `~/.gemini/settings.json` `hooks` (`BeforeAgent`/`AfterAgent`/`SessionStart`/`SessionEnd`, same shape; the implementer runs `HOME=<sandbox> gemini hooks migrate` once against a sandbox Claude settings to confirm the container shape, falls back to skipping Gemini hooks if it differs); parse-mutate-stringify, first-install snapshot under `$GARRISON_HOME/snapshots/shells-<name>.before.json`; skip absent homes; no-op when `GARRISON_REMOTESHELLRUNTIME_INSTALL_HOOKS=false` or win32. `FIT/scripts/uninstall-hooks.mjs` removes entries whose `command` contains `agent-event-hook.sh`. Claude hooks are NOT touched (dev-env owns them; the registry carries status).
- `scripts/sync-state-client.mjs`: add `fittings/seed/remote-shell-runtime/lib/state-client.mjs` to `SYNC_MANIFEST[0].targets`; run it (pinned by `tests/state-client-drift.test.ts`).
- `FIT/lib/node-identity.mjs` (new): `nodeName()` = `GARRISON_NODE_NAME` || `state.json.node` || `node.json.id`; `shellOrigin({port})` per 2.2.
- `FIT/lib/index-publisher.mjs` (new; skeleton = `packages/talk/src/thread-registry.mjs`): `createStateClient({readFileSync, timeoutMs:3000})` from the mirror; `getConfig` -> `putConfig(..., {ifMatchRev: doc?.rev ?? 0})`, one 409 retry, debounced 2 s, unenrolled -> warn once + disable; full snapshot, no merge.
- `FIT/scripts/server.mjs`: `refresh()` = `buildIndex` + `publisher.schedule`, on session start/remove/state change (`manager.onChange`) and every `index_publish_seconds` (default 10, unref'd, skipped while a build is in flight); `GET /index`; `FIT/lib/origin-guard.mjs` (2.6) applied first in the request handler and in `server.on("upgrade")`; `/exec` + `/agent-turns` refuse `Origin`; re-run the hook installer's function at boot (import, never spawn).
- `FIT/apm.yml`: description/summary around "Shells"; `config_schema` adds `local_shells` (bool, true), `local_projects_root` (`~/dev`), `local_login_shell` (""), `install_hooks` (true), `session_window_days` (5), `index_publish_seconds` (10); `setup.command`: `node scripts/link-devtunnel-home.mjs && node ui/build.mjs && node scripts/install-hooks.mjs`; `ui.views: [{id: shells, placement: sidebar-surface, entry: ./dist/index.html, route: "/"}]` (the existing dist); `for_consumers` rewritten with the REST contract, doc/Row shape, CORS rule, Codex trust caveat, uninstall script. Do NOT add a new capability kind (CLAUDE.md rule); `provides` stays `runtime: remote-shell`. `data/library.json` entry: `"name": "Shells"` + summary. `FIT/scripts/probe.mjs` imports the new modules; passes without tmux.

Tests: `tests/shells-listers.test.ts` with fixtures under `tests/fixtures/shells/` (`claude-home/{sessions/<pid>.json (process.pid live + a dead pid), projects/-tmp-x/<id>.jsonl with ai-title tail}`, `codex-home/{session_index.jsonl, sessions/2026/09/03/rollout-*.jsonl incl. one subagent}`, `cursor-home/{projects/tmp-x/agent-transcripts/<id>/<id>.jsonl, chats/ws/<id>/meta.json}`, `gemini-home/{projects.json, tmp/x/chats/session-*.jsonl}`, `garrison-home/web-channel/threads/t1.json`, `events.jsonl`): shapes, internal-cwd drop, subagent skip, gemini `{index:2, latest:true}`, desktop vs cli kind, hook beats mtime, mtime 5 s -> working / 5 min -> unknown, history -> ended, claim tagging, owned-pane dedupe, build under 2 s. `tests/shells-hooks-install.test.ts` (mirror `tests/dev-env-hooks-install.test.ts`: pre-existing entries preserved, idempotent twice, snapshot once, uninstall removes only ours, absent home skipped). `tests/shells-index-publisher.test.ts` (real state service via `tests/state-service-harness.ts` as `tests/kanban-state-env.ts` does: two publishes -> rev 2; 409 retry; unenrolled no-throw; `shellOrigin` with/without tailnetHost and with override). `tests/shells-origin-guard.test.ts` (pure verdicts + a booted server: OPTIONS 204 from a `.ts.net` Origin, 403 from `https://example.com`, WS upgrade refused with 403 via `ws` client). `tests/state-client-drift.test.ts`, `tests/vocabulary.test.ts`, `tests/instance-isolation.test.ts`.

Verify: suites; `npm run node:redeploy`; live: `curl -s 127.0.0.1:8098/index | jq '.rows[:3]'` shows this session (`claude`, working); `curl -s -H "Authorization: Bearer $(jq -r .token ~/.garrison/state.json)" "$(jq -r .url ~/.garrison/state.json)/v1/config/shells.sessions/node:dev-madrid" | jq '.body.rows|length'`; `ls ~/.garrison/shells/`; `cat ~/.codex/hooks.json` shows our groups. Evidence: those outputs.

### G3. Talk: aggregated list, live rail, direct-origin client

- `packages/talk/src/threads.mjs`: `shellBinding(thread)` (strict pick + length caps; `shellOrigin` must parse as http(s) URL); `toMeta` adds `shell` and `claudeSessionId`.
- `packages/talk/src/mesh-sessions.mjs` (new): `normalizeSessionRow(raw, node)` (tolerates the legacy fitting `state:"running"`), `meshSessions({limitEndedPerNode=20})`: local rows from `GET <readRemoteShellInfo().url>/index` (2 s TTL; fallback own doc), peer rows from `getConfig("shells.sessions","node:<peer>")` per `listNodes()` peer (5 s TTL; `nodeAccent` via `ACCENT_HEX`, `nodeStatus`, `lastSeenAt`, `shellOrigin = body.shellOrigin.public`); bind to local threads (`t.shell` match by `node + sessionId` or `transport + tmuxSession` -> `threadId`; Claude `t.claudeSessionId === row.id` -> `boundTo {kind:"conversation", threadId}`); sort working > idle > unknown then `lastActivityAt` desc; cap ended per node. Export `selfIdentity` from `mesh-threads.mjs` for reuse.
- `packages/talk/src/transcript-formats.mjs` (new): `parseCursorTranscriptLines` (uses exported `parseBlock` from `session-transcript.mjs`), `parseCodexRolloutLines` (`response_item.payload.type`: `message` user/assistant text (developer skipped), `reasoning` -> thinking, `function_call`/`custom_tool_call` -> tool_use `{toolUseId: call_id, name, input}`, `*_call_output` -> tool_result; `event_msg` ignored; ts from line `timestamp`), `parseGeminiChatLines` (skip header; apply `$set.messages` replace semantics, ignore unknown ops; `type:"user"` / `"gemini"`), `parseByFormat(format, lines)` with `claude-jsonl` -> `parseTranscriptLines`.
- `packages/talk/src/router.mjs`: `matchShellSession`; `handleThreadsList` joins `meta.shell` + `runningSince`; `GET /api/sessions` (`handleSessionsList`, never 5xx: `{self, nodes:[], rows:<local>}` on state failure); `GET /api/sessions/:id/stream` (`handleExternalSessionStream`, factor the tail loop of `handleSessionStream` into `streamJsonlFile(res, abs, parseFn)`); dispatch `/api/sessions*` before `/api/threads`.
- `src/lib/mesh/peer-proxy.ts`: the ALLOW row of 2.4.
- `packages/talk/ui/shell-origin.ts` (new): `resolveOriginForPage(view, loc)` (pure twin of `resolveViewUrl`, "" when unreachable), `resolveShellOrigin(row, self)` (peer -> `row.shellOrigin`; local -> `GET /api/fittings/views` 60 s memo, `fittingId === "remote-shell-runtime"`), `shellFetch(origin, path, init, {timeoutMs=8000})` (`mode:"cors"`, `credentials:"omit"`, throws `ShellOriginError {kind: "no-origin"|"unreachable"|"cors"|"http"|"offline", status?, detail}`; cors classified via a `no-cors` `/health` retry), `shellSocketUrl(origin)`, `errorCopy(err, nodeName, lastSeenAt)` -> `{title, sub, hint}` (copy in the Part 2 design: unreachable / cors / no-origin (names `scripts/tailnet-serve-views.mjs`) / offline).
- `packages/talk/ui/remote-shell-pane.tsx`: prop `ioUrl?` (default = legacy relay URL); on `(pointer: coarse)` set `term.textarea.inputmode="none"` so a tap scrolls without raising the keyboard.
- `packages/talk/ui/app.tsx`: `ThreadMeta.shell?`, `claudeSessionId?`; state `sessions`, `sessionNodes`; `apiListSessions()`; refresh clock per 2.4; mesh-threads poll 30 s.
- `packages/talk/ui/sessions-rail.tsx`: `RailSession` type; `Row.kind: "local"|"remote"|"session"`, `runtime`, `project`, `status`, `sessionKind`; pure `buildRailRows(threads, meshNodes, sessions, self)` exported (dedupe: bound rows hidden, owned threads enriched, peer-owned hidden); render order: runtime badge (`.wc-thread-src.wc-thread-rt` text `CLAUDE|CODEX|CURSOR|GEMINI|SHELL`, plus chip `desktop`/`bg`), node chip (`.wc-thread-node`, `--node-accent`), project chip (`.wc-thread-proj`, title = cwd), status word (`Working` pulse `.wc-thread--working`, `Idle`, `Ended` `.wc-thread--ended`), `fmtWhen(lastActivityAt)`. ONE auto section "Sessions" first in `.wc-side-scroll`: header with count (collapse in `localStorage["wc.sessions.collapsed"]`), per-node sub-heads (`.wc-sessions-node`, accent dot + name + count), sort working > idle > unknown then recency, ended hidden behind "Show ended (N)"; session rows not draggable; context menu: Open, Continue in a shell, Copy resume command. `+ New` menu gains "New shell...". Mobile (390x844): same section in the drawer; chips wrap; tap opens and closes the drawer. Owned shells remain ordinary thread rows (organizer, drag, groups keep working). Testids: `rail-row[data-key]`, `rail-section-sessions`, `rail-sessions-toggle`, `rail-node-<node>`, `rail-show-ended`, `rail-rt`, `rail-node-chip`, `rail-project`, `rail-status`, `rail-new`, `rail-new-shell`.

Tests: `tests/talk-mesh-sessions.test.ts` (fixture threads + two node docs + legacy local shape; injected state client), `tests/talk-shell-binding.test.ts`, `tests/talk-transcript-formats.test.ts` (fixtures `tests/fixtures/transcripts/{cursor,codex,gemini}.jsonl` captured from real files on the mini/dev-madrid; torn last line), `tests/mesh-proxy.test.ts` (new row), `tests/talk-shell-origin.test.ts` (parity with `resolveViewUrl`: loopback, tailnet, https+no mapping -> "", LAN rebind; error classification with stubbed fetch), `tests/talk-rail-rows.test.ts`.

Verify: suites + typecheck; `npm run node:reload` (talk is app code) then `npm run node:redeploy` if `packages/talk/src` changed the server side used by the fitting (it does not; reload suffices); live: `curl -s 127.0.0.1:8777/api/sessions | jq '.rows[0]'`; `curl -N 127.0.0.1:8777/api/sessions/<id>/stream | head -3`; browser at `https://dev-madrid.tail31efa.ts.net/talk`: Sessions section with this Claude session pulsing "Working"; the mini's rows appear once the mini runs G2 code (section 4). Evidence: desktop + 390x844 screenshots (working, idle, ended rows).

### G4. Talk: owned-shell workbench, external session view, New shell, styles

- `packages/talk/ui/remote-shell-workbench.tsx`: props `mode?: "delegate"|"shell"`, `origin`, `originError`, `nodeName`, `onRetryOrigin`, `onSendInput`, `onSendKeys`; `shell` mode = deck (44 px: lamp, state, elapsed, serif title, crumb `<NODE> / <transport> / TMUX:<name>`, Reattach) + full-height pane + `<ShellComposer>`; no seam/ledger; `reattach` -> `shellFetch(origin, "/sessions", {..., recycle:true})`; `deckState` adds `"unreachable"` (plaque from `errorCopy`, `wb-retry`); `ioUrl = shellSocketUrl(origin)`.
- `packages/talk/ui/shell-composer.tsx` (new): textarea (`enterkeyhint="send"`, Enter sends, Shift+Enter newline; auto-grow 4 lines; 16 px font under 600 px), Send (44 px), Keys strip `Esc, Ctrl+C, Up, Down, Tab, Enter, Ctrl+D` -> tmux names `Escape, C-c, Up, Down, Tab, Enter, C-d` via `/keys`; draft in localStorage per thread. Testids `wb-composer`, `wb-composer-input`, `wb-composer-send`, `wb-keys-toggle`, `wb-key-<name>`, `wb-error`, `wb-retry`, `wb-reattach`.
- `packages/talk/ui/session-view.tsx` (new): `ExternalSessionView({row, self, nodes, onContinue, onAttach, onOpenCursor, onClose})`: deck-style header (lamp by status, runtime badge, node chip, project; subline "Running in another terminal on <node>" / "Ended on <node>" / "Cursor desktop, <project>"); actions: Continue in a shell (`resumable`), Attach (`claude` + `bg`), Open in Cursor (`desktop` AND the page host is the owning node; `cursor://file/<cwd>`), Copy resume command (`row.resumeCommand`); body `<SessionStream>` on `/api/sessions/<id>/stream` (self) or `/api/mesh/nodes/<node>/sessions/<id>/stream` (peer), live while not ended; no transcript -> `.wc-sess-note`. Resume refusal: after Continue, poll `GET <origin>/sessions/<id>/screen?lines=40` every 1.5 s for 8 s; `detectResumeRefusal(text)` (`packages/talk/ui/resume-refusal.ts`, fixture-seeded regexes per runtime, e.g. `/no (chat|conversation) (found|with)|could not resume|invalid (chat|session) id|not found/i`) -> banner "…refused to resume: <line>" + `sess-newagent` (create without `resume`). Testids `sess-view`, `sess-head`, `sess-continue`, `sess-attach`, `sess-open-cursor`, `sess-copy-resume`, `sess-newagent`, `sess-transcript`, `sess-note`, `sess-close`.
- `packages/talk/ui/new-shell-modal.tsx` (new): node segment (roster + self; offline/stale disabled with "last seen <ago>"), transport (hidden when only `local`), runtime (`GET origin/runtimes`; unavailable disabled with reason), project (recent cwds from the index for that node, then `GET origin/projects`, then manual path), optional resume (resumable rows for node+runtime+cwd or free id), Start -> `POST origin/sessions`; errors via `errorCopy`. Testids `newshell-modal`, `newshell-node-<node>`, `newshell-transport-<name>`, `newshell-runtime-<id>`, `newshell-project-<slug>`, `newshell-path`, `newshell-resume`, `newshell-start`, `newshell-cancel`, `newshell-error`.
- `packages/talk/ui/app.tsx`: `activeShellSpecJson` (string key, like `activeRshSpecJson`); ensure-session effect (`resolveShellOrigin` -> `POST /sessions` -> `shellSessionId`; `ShellOriginError` -> `shellError`); render workbench `mode="shell"` for `source === "shell"` (no ClaudeChat); `activeSession` state + `?session=<node>:<id>` deep link; `continueSession(row)` -> `POST origin/sessions {transport: row.shell?.transport ?? "local", runtime, cwd, resume: row.id, attach: row.kind === "bg", label}` -> `apiEnsureThread({id: "shell-<node>-<transport>-<tmux>", title, source:"shell", context:{shell:{...}}})` -> open + refresh; `startNewShell(spec)` same; keep `ShellsModal` for the legacy transport button.
- `packages/talk/ui/styles.css` (append after the workbench block; Fortress vars only): `.wc-thread-rt`, `.wc-thread-node::before` 6 px dot `var(--node-accent, #6a746b)`, `.wc-thread-proj` (mono 10 px, `max-width:14ch`, ellipsis), `.wc-thread-status`, `.wc-thread--ended {opacity:.62}` + hollow dot, `.wc-thread--idle .wc-row-dot`, `.wc-sessions-node` (28 px sub-head), `.wc-show-ended` (44 px on coarse pointer), `.wc-wb-composer` (`padding-bottom: calc(8px + env(safe-area-inset-bottom))`, `--wc-olive-900` bg, 1 px top border), textarea 16 px under 600 px, `.wc-wb-composer-send` brass 44 px, `.wc-wb-keys` scroll strip, `.wc-wb-key` mono chip 44 px coarse, `.wc-sess*`, `.wc-newshell-seg`, `@media (prefers-reduced-motion: reduce)` disables pulses. Deck stays 44 px. Everything on the 8 px grid, contrast >= 4.5:1 for muted text.

Tests: `tests/talk-resume-refusal.test.ts`, `tests/talk-resume-command.test.ts` (derivation table), `recentProjects(sessions, node)` in `tests/talk-rail-rows.test.ts`; typecheck; `tests/vocabulary.test.ts` (whitelist the new files where "session" is a real tmux/runtime session; never "operative").

Verify: `npm run node:reload`; live on dev-madrid and from a phone/390 px: open the Claude session row (external view streams this very transcript), Continue in a shell -> owned thread with deck + pane + composer, type `echo hi` in the composer and see it in the pane, Ctrl+C key chip, New shell -> `codex` in `~/dev/garrison`. Evidence: desktop + mobile screenshots of rail, external view, workbench, New shell modal; `POST /sessions/<id>/input` in the network log.

### G5. Cursor: stationing, Quarters file sets, the mini

- `fittings/seed/cursor-runtime/scripts/bridge.mjs`: `probeFailure` returns `{level: "absent"|"unauthenticated", reason}`; `--probe` prints `ok` + `degraded: no cursor-agent on this node (<reason>)` and exits 0 ONLY when the binary is absent (also try `~/.local/bin/cursor-agent` before declaring absent); present-but-unauthenticated still exits 1; `GARRISON_REQUIRE_CURSOR=1` forces strict (set in the mini's launchd env; documented in `for_consumers`). Rationale: `verify()` failure aborts `up()` for the whole shared composition (`src/lib/runner.ts:599-603`) and `local.yml` cannot vary membership (G6 adds `unstation`, but a converge to a node without cursor-agent must not break `up`).
- `compositions/default/apm.yml`: dependencies add `- path: ../../fittings/seed/cursor-runtime`; `selections.runtimes` add `- id: cursor-runtime` `config: {model: auto}`; targets add `cursor-local` (`runtime: cursor`, `model: auto`, `params: {type: secondary}`); keep `csg-work`/`csg-exec` until csg is a node (then `cursor-local` on csg's own composition covers it; note in the decision doc). Run `up` (fingerprint changes -> full install/verify) and commit `apm.lock.yaml`.
- Quarters file sets:
  - `src/lib/metadata.ts`: strict `quartersFileSetSchema` `{id (kebab), label, root, glob (restricted: segments literal | "*" | "*.ext" | "{a,b}.ext", depth <= 2, no ".." / leading "/"), format: markdown|json, frontmatter?: string[] (markdown only), create?: bool, write?: replace|merge (merge only with json), platform?: darwin|linux|win32, scope?: home|project}`; `file_sets?: []` on both tiers; refine unique ids. `src/lib/types.ts`: `QuartersFileSet`.
  - `src/lib/quarters-runtimes.ts`: `runtimeHome(descriptorId, env)` = `env["GARRISON_<ID>_HOME"]` (e.g. `GARRISON_CURSOR_HOME`) else `os.homedir()`; `expandHome(p, homeDir)`; thread it everywhere; `matchRestrictedGlob`, `isRestrictedGlob`; `knownProjectRoots()` (children of `global_config.projects_root` + cwds from the local fitting `GET /index`, 2 s timeout); `listFileSet`, `readFileSetEntry`, `writeFileSetEntry` (glob + realpath containment, `GARRISON-PROJECTED` refusal, sha guard, json validation, `write: merge` -> deep merge, arrays unioned, keys never removed), `createFileSetEntry`, `deleteFileSetEntry` (only `create: true`), `parseFrontmatter` (js-yaml, non-throwing); `resolveRuntimeQuarters` entries gain `fileSets: [{id, label, available, reason, count}]`.
  - Routes: `src/app/api/quarters/runtime/[rid]/sets/route.ts`, `.../sets/[set]/route.ts` (GET entries `?project=`), `.../sets/[set]/file/route.ts` (GET `?rel=`, PUT `{rel, content, baselineSha, project?}`, POST create, DELETE), `.../projects/route.ts`.
  - `src/components/quarters/RuntimeFileSetPanel.tsx` (new): entry list + editor (markdown -> `MarkdownEditor` with autosave PUT and frontmatter chips; json -> `RuntimeFileEditor` generalised with `loadUrl/saveUrl/savePayload`), merge note for hooks, `qs-unavailable` with reason, create/delete with confirm, projected files read-only. Testids `qs-project-picker`, `qs-entry-<rel>`, `qs-frontmatter`, `qs-merge-note`, `qs-unavailable`, `qs-create`, `qs-create-name`, `qs-create-save`, `qs-delete`.
  - `src/app/quarters/[type]/[sub]/page.tsx`: render the panel when `sub` is a `file_sets` id. `QuartersIndex.tsx` `GENERIC_CATEGORY_META`: `rules` (ScrollText), `skills` (Sparkles), `agents` (Bot), `hooks` (Webhook), `desktop` (Monitor), `project-rules` (FolderCog); unavailable pill.
  - `fittings/seed/cursor-runtime/apm.yml` `quarters_descriptor.file_sets`: rules (`~/.cursor/rules`, `*.mdc`, frontmatter `[description, globs, alwaysApply]`, create), skills (`~/.cursor/skills`, `*/SKILL.md`, `[name, description]`, create), agents (`~/.cursor/agents`, `*.md`, create), hooks (`~/.cursor`, `hooks.json`, json, `write: merge`), desktop (`~/Library/Application Support/Cursor/User`, `{settings,keybindings}.json`, json, `platform: darwin`), project-rules (`.cursor/rules`, `*.mdc`, `scope: project`, create); `categories: [settings, context, mcps, rules, skills, agents, hooks, desktop, project-rules, logs]`.
- The mini (section 4 rollout first): install hooks (`node fittings/seed/remote-shell-runtime/scripts/install-hooks.mjs` runs at `up`), confirm `~/.cursor/hooks.json` gained our two entries and the pre-existing content is intact; confirm `cursor-agent` works inside a Garrison-owned pane (keychain: the GUI session must be logged in; over plain ssh the keychain is locked); list shows the mini's Cursor desktop sessions; Continue on a desktop row records the outcome (resume accepted or refusal banner) in the ledger and the decision doc.

Tests: `tests/cursor-runtime.test.ts` (probe table: absent -> degraded exit 0; present+unauthenticated -> 1; `GARRISON_REQUIRE_CURSOR` strict; manifest parses), `tests/composition-default-stations-cursor.test.ts`, `tests/quarters-file-sets.test.ts` (temp home via `GARRISON_CURSOR_HOME`: list/read/write/create/delete; `../x.mdc` refused; symlink escape; frontmatter; merge keeps removed keys + unions arrays; projected refusal; platform gating with injected platform; project scope refused for unknown path; fast-check: no rel outside the glob readable), `tests/metadata-quarters-file-sets.test.ts`, `tests/quarters-runtimes.test.ts`.

Verify: `node fittings/seed/cursor-runtime/scripts/bridge.mjs --probe; echo $?` on dev-madrid (ok + degraded, 0) and on the mini via ssh (`zsh -lc`, ok, 0); `npm run node:redeploy` on dev-madrid (apm.yml changed) and on the mini (section 4); Muster shows cursor-runtime standing; `/quarters/cursor-runtime/rules` on the mini lists `indy-frontend-apps-all-prs.mdc` and autosave writes to disk (verify with `ssh mini cat`). Evidence: probe outputs, runner log line, Muster + Quarters screenshots (desktop + mobile), the mini's Sessions rows with Cursor desktop entries, the resume attempt result.

### G6. csg: VS Code tunnel, tether, preflight, installer, unstation (code + preflight only)

- `FIT/lib/transports.mjs` `normalizeTransport`: `tether` per 2.5 (`normalizeTether`), `via.devtunnel.pushHostToken`; `FIT/lib/host-credential.mjs` skips `pushHostToken === false`; delete `FIT/scripts/host-tunnel.sh` + `tests/remote-shell-host-tunnel.test.ts`; fix the comments citing it.
- `FIT/lib/tether.mjs` (new): `TetherManager({spawnFn, exec = transportExec, tunnels, log, notify})`: one `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 [-R 127.0.0.1:<remotePort>:127.0.0.1:<localPort>]... [-L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>]... <sshArgv>` child per tethered transport; states `down -> connecting -> up -> suspect -> down`; `ensure()` idempotent, serialised, awaits `tunnels.ensure` first; health every 20 s (skip when the tunnel is unhealthy): local legs via `probeRoundTrip` (export it from `forwards.mjs`) on each `-L` port, reverse leg via `exec(transport, "curl -sf --max-time 5 http://127.0.0.1:8460/v1/health")`; two misses -> retire (SIGTERM, SIGKILL after 2 s, awaited) -> respawn with the transports backoff ladder; on down->up run `onUp` via `bash -lc` and `notify` once per transition; `status()` = `{state, since, lastOkAt, misses, child, legs:{app, shells, state}, lastError}`; writes `$GARRISON_HOME/remote-shell/tether.json {transport, node, forwards:[{name, localPort, servePort}]}`; `server.mjs` routes `GET /tether`, `POST /tether/:transport/repair`; chained into `tunnels.onRecovered`.
- `scripts/lib/tailnet-serve-cli.mjs` (extract `tailscale()`, `tailscaleServeWrite()`, `serveStatus()`, `existingMappings()`, `enrich()` from `scripts/tailnet-serve-views.mjs`; `pickServePort` stays in the views script so `tests/mesh-serve-ports.test.ts` keeps passing) and `scripts/tailnet-serve-tether.mjs` (node-profile + `node.json` guards; reads `tether.json`; idempotent `tailscale serve --bg --https=<servePort> http://127.0.0.1:<localPort>`; refuses 84xx). `scripts/garrison-redeploy.sh`: after the views publish, `node scripts/tailnet-serve-tether.mjs || echo "[redeploy] tether publish failed"`. `scripts/tailnet-serve-views.mjs`: on a `node.json.tethered` node print `tethered node: views are published by <tetherHost>` and exit 0.
- `scripts/install-node.sh`: flags `--tethered`, `--tether-host`, `--app-origin`, `--shell-origin`, `--repo-source github|mirror`, `--token-stdin`; tethered = preflight without tailscale + `curl -sf --max-time 10 http://127.0.0.1:8460/v1/health` (proves the `-R` leg), `NO_PROXY=127.0.0.1,localhost` when a proxy is set, mirror clone `ssh://ggomes@127.0.0.1:2200/home/ggomes/dev/garrison` with `core.sshCommand` using `~/.ssh/garrison-tether`, `node.json` with `tailnetHost: null, tethered, tetherHost, appOrigin, shellOrigin`, `state.json` url `http://127.0.0.1:8460`, skip the vault-git-sync Claude hooks, supervisor = systemd-user when pid1 is systemd and `systemctl --user` works (plus `loginctl enable-linger`), else `scripts/node-supervisor.sh` (new, POSIX sh: `daemon|ensure|start|stop|restart|status|run`, `setsid nohup`, pid files, child pgid kill, 5 s backoff, exports `GARRISON_NODE_NAME`, `NO_PROXY`, PATH incl. `~/.local/bin`, every 10 min `sudo -n hwclock -s` when allowed), skip `tailscale serve`, final line prints `Open <appOrigin>/`.
- `scripts/garrison-redeploy.sh` + `scripts/garrison-reload.sh` `restart_supervised()`: try `garrison-prod.service` THEN `garrison-node.service` (bug: a fresh Linux node cannot redeploy today), then launchd, then `~/.garrison/node-supervisor.sh restart`.
- `src/lib/compositions.ts`: `local.yml` `unstation: string[]` (top level or under `x-garrison.composition`), applied after the config merge, logged once, refuses `orchestrator`/`http-gateway`/`scheduler`; `up-fingerprint.ts` already hashes `local.yml`; `src/lib/mesh/self-snapshot.ts` `composition.unstationed`; `MeshPanel` renders it muted; `docs/INSTANCES.md` + CLAUDE.md line. `scripts/remote-shell/csg-local.yml.example` with the unstation list (codex-runtime, gemini-runtime, opencode-runtime, browser-default, screen-share-default, snapshots-default, basic-memory, vault-git-sync, improver, improver-nightly, slack-channel, email-channel, omi-channel, whatsapp-web, capture-service, trello, google, cortex-automations, cortex-client) and `remote-shell-runtime.config.transports: '{}'` (csg must not dial its own tunnel).
- App side: `src/lib/node-identity.ts` (new fields), `src/lib/node-switch.ts` `nodeAppOrigin({tailnetHost, appOrigin})`, `src/lib/mesh/node-row.ts` (`appOrigin` from `health.node.appOrigin`), `src/lib/mesh/peer-proxy.ts` `peerAppBase` prefers `appOrigin`, `NodeSwitcher.tsx` enables `appOrigin` peers, `packages/talk/src/mesh-threads.mjs` `openUrl` uses `appOrigin` when set; pin `crossSiteVerdict` passes Host `dev-madrid.tail31efa.ts.net:8977` (it already strips the port; add the test).
- `scripts/remote-shell/csg-node-preflight.sh` (runs ON csg over `ssh csg 'bash -lc "bash -s"'`, read-only, prints ONE JSON) + `scripts/remote-shell/csg-node-preflight.mjs` (dev-madrid runner: `devtunnel user show` login check FIRST (expired -> STOP with `devtunnel user login -g -d`), `describeTunnel("swift-book-df6tw47.eun1")` hostConnections >= 1 and port 2222 listed, `probeSshBanner` up, `sshExec "true"`, 5x round trip p50/p95; remote checks: WSL2 + pid1 + `systemctl --user`, node >= 20.11 or nvm-installable, `npm ping`, git >= 2.30, GitHub reachability (`git ls-remote https://github.com/gongiskhan/agent-garrison.git main` -> `repoSource: github|mirror`), disk >= 15 GB, RAM >= 8 GB, nproc, tools (tmux python3 curl ssh gcc make g++ sqlite3 claude codex gemini cursor-agent devtunnel code), sudo, sshd `AllowTcpForwarding yes` (NO-GO otherwise), proxy env, clock skew <= 60 s, `code tunnel` host location, peaceful-ocean host state, `~/dev/garrison` not a symlink, `~/.cursor` inventory (sha256 of hooks.json, cli-config.json, mcp.json, `*.mdc`, `SKILL.md`, `~/dev/pnmui-monorepo/.cursor/rules`, `.cursorrules`, AGENTS.md marker) recorded verbatim to PRESERVE; verdict `{verdict: GO|GO-WITH-FIXES|NO-GO, fixes[], repoSource, supervisor, tunnelPlan: swift-book|peaceful-ocean, unstationSuggested[]}` to `evidence/shells/csg/preflight-<ISO>.json`; `--survival [--survival-hours N]` = the port-survival protocol: operator closes every VS Code/vscode.dev window attached to csg (AskUserQuestion), then every 5 min `describeTunnel` + banner + `sshExec true` appended to `port-survival.jsonl`; if 2222 vanishes try once `devtunnel port create swift-book-df6tw47.eun1 -p 2222 --protocol auto` and re-run 30 min; still dropping -> `tunnelPlan: peaceful-ocean`.
- `compositions/default/apm.yml` + `compositions/openai/apm.yml` csg transport: `via.devtunnel.tunnel = "swift-book-df6tw47.eun1"`, `pushHostToken: false`, the `tether` block of 2.5. Keep peaceful-ocean's `host-tunnel.sh` running on csg until G8 passes (fallback), then stop it by hand.
- `scripts/remote-shell/csg-node-install.sh` (dev-madrid runner for G7): tether key on csg (`~/.ssh/garrison-tether`), dev-madrid `authorized_keys` entry `from="127.0.0.1",no-pty,no-agent-forwarding,no-X11-forwarding,no-port-forwarding,command="<repo>/scripts/remote-shell/git-only-shell.sh"` (new 12-line script: only `git-upload-pack`/`git-receive-pack` for `/home/ggomes/dev/garrison`), `node scripts/issue-node-token.mjs csg --platform linux --accent steel` in the state service checkout, scp the installer to csg `/tmp`, run it with the token on stdin and `--tethered --tether-host dev-madrid --name csg --accent steel --state-url http://127.0.0.1:8460 --app-origin https://dev-madrid.tail31efa.ts.net:8977 --shell-origin https://dev-madrid.tail31efa.ts.net:8998 --repo-source <preflight>`, write csg's `compositions/default/local.yml` from the example, `~/.ssh/config` `Host csg` on dev-madrid; verify `curl -sf https://dev-madrid.tail31efa.ts.net:8977/api/mesh/self` and csg in `/api/mesh/nodes`. Mirror mode extras: scheduler job `csg-branch-relay` on dev-madrid every 15 min `git -C ~/dev/garrison push -q origin node/csg`. `scripts/remote-shell/csg-node-redeploy.sh [reload|redeploy]` = `ssh csg 'bash -lc "cd ~/dev/garrison && git fetch -q origin && git merge -q --ff-only origin/node/csg; npm run node:<verb>"'` + the checks. Secrets: minimal grants issued on dev-madrid (`POST /v1/secrets/grants {node:"csg", pattern:"CLAUDE_CODE_OAUTH_TOKEN"}`); operator decides csg's Claude auth before G7 (non-interactive: `claude setup-token` on dev-madrid delivered as a secret); no channel/personal keys reach the VM.

Tests: `tests/remote-shell-tether.test.ts` (fake `spawnFn` as in `tests/remote-shell-forwards.test.ts`: argv carries both `-R` and `-L`, `ExitOnForwardFailure`, owner gate, two-miss retire, `onUp` once per edge, `status()` shape), `tests/remote-shell-forwards.test.ts` (unchanged legacy), `tests/remote-shell-host-credential.test.ts` (`pushHostToken:false` skipped), `tests/composition-local-overlay.test.ts` (unstation semantics, refused ids, cannot add), `tests/node-identity.test.ts`, `tests/node-switch.test.ts`, `tests/mesh-proxy.test.ts`, `tests/mesh-self.test.ts`, `tests/mesh-serve-ports.test.ts` (tether servePorts in `scripts/remote-shell/csg-transport.example.json` outside 8400..8499 and distinct), `tests/tailnet-serve-views.test.ts` (spawn with scratch HOME: tethered exits 0; tether script refuses 84xx), `tests/remote-shell-runtime.test.ts`.

Verify: suites; `npm run node:redeploy` on dev-madrid; `curl -s 127.0.0.1:8098/tether | jq`; when csg is up: `node scripts/remote-shell/csg-node-preflight.mjs` -> verdict JSON in `evidence/shells/csg/`. If csg is unreachable: ledger `G6: done (code), preflight blocked: csg off`, retry the preflight at the start of F1 and F2.

### G7. csg install (only on GO / GO-WITH-FIXES and csg up)

`bash scripts/remote-shell/csg-node-install.sh` (apply only the fixes the verdict lists first, re-run preflight). Done when csg appears on dev-madrid's `/mesh` within 45 s, `https://dev-madrid.tail31efa.ts.net:8977/api/mesh/self` answers 200 from the Mac/phone, and `up()` on csg is green with the unstation list (extend the list and re-run `up` for anything else that fails verify; record every addition). Evidence: install log, `/mesh` screenshot, csg's `up` log tail, preserved `~/.cursor` inventory diff = empty except the hooks.json merge.

### G8. csg in the app

NodeSwitcher switches dev-madrid -> csg (full navigation to `appOrigin`); csg's Sessions rows (cursor-agent tmux sessions incl. the pre-existing `csg`, `pnmui-monorepo*` ones, plus Cursor transcripts on csg) appear in dev-madrid's list under a "csg" node head; attach to a csg tmux session through `:8998`; `/quarters/cursor-runtime/rules` on csg lists the hand-built rules read/write; `/mesh` shows csg with its unstationed list. Then retire `csg-work`/`csg-exec` targets in favour of `cursor-local` on csg (decision doc) and stop peaceful-ocean's `host-tunnel.sh` on csg. Evidence: screenshots (desktop + 390 px) + the ledger.

## 4. Mesh rollout (needed for "the mini shows Cursor sessions")

After G2 and again after G4/G5: push `main` (owner bypass message is EXPECTED), then on the mini:
`ssh ggomes@goncalos-mac-mini-1 'zsh -lc "cd ~/dev/garrison && git fetch -q origin && git merge --no-edit origin/main && npm run node:redeploy"'`
(the mini works on `node/goncalos-mac-mini-1`; merging `main` into it is the sanctioned direction; never create a branch). Confirm `curl -s https://goncalos-mac-mini-1.tail31efa.ts.net/api/mesh/self | jq .git` shows the new head and `.../api/sessions` (via the mini's origin) lists Cursor rows. The Air and the MacBook Pro pick it up at the nightly converge (or the same command when the operator wants it). Record heads in the ledger.

## 5. Test strategy summary

Vitest per gate (listed inline). Playwright specs are written in F2 (section 9), from the E2E learnings, using
`playwright.web-channel.config.ts` (extend `testMatch` to `/web-channel-(chat|session-parity|shells|shells-peers)\.spec\.ts$/`)
with `tests/e2e/fixtures/talk-app.ts` `startTalkApp` + two new fixtures: `tests/e2e/fixtures/fake-shells-fitting.ts`
(http + `ws`: CORS for the page origin, `/health`, `/index`, `/sessions`, `/transports`, `/runtimes`, `/projects`,
`POST /sessions`, `/input`, `/keys`, `/screen`, WS `/io` with `init_ack {tmux:true}` + banner + echo; the spec writes
`<home>/ui-fittings/remote-shell-runtime.json {fittingId, port, url, pid, startedAt}` before boot) and
`tests/e2e/fixtures/fake-state-service.ts` (`/v1/health`, `/v1/nodes` with a tailnet peer + a tethered peer with
`health.node.appOrigin`, `/v1/config/shells.sessions/node:<n>` canned docs; the spec writes `<home>/state.json` and
`<home>/node.json`). Specs: `tests/e2e/web-channel-shells.spec.ts` (desktop + mobile: rows + badges, working pulse
within 10 s after `setState(running)`, open owned shell + bytes round trip through xterm, composer POST, key chip,
new-shell POST body, external transcript view, mobile: rows >= 44 px, no horizontal scroll),
`tests/e2e/web-channel-shells-peers.spec.ts` (node heads with accent dots, tethered peer Open link = `appOrigin`,
peer without address disabled, state service down -> one banner + local rows), `tests/e2e/quarters-cursor.spec.ts`
(base config; `tests/e2e/sandbox.ts` gains `CURSOR_SANDBOX` seeded with rules/skills/agents/hooks/desktop settings and
`playwright.config.ts` webServer env `GARRISON_CURSOR_HOME`; list, autosave to disk, create/delete, merge note, desktop
set unavailable on linux). Any suite that launches Chromium goes into `BROWSER_FIXTURE_SUITES` (`vitest.workspace.ts`).
Final green run with `GARRISON_E2E_VIDEO=1`, artifacts copied to `evidence/shells/final/`.

## 6. Risks and fallbacks

- csg off / tunnel unhosted / `devtunnel` login expired on dev-madrid (lasts < 1 day; only `devtunnel user login -g -d` fixes it): G6 preflight blocks, G7/G8 skipped, retried at F1 and F2; the plan still delivers everything else.
- VS Code tunnel drops 2222 without a VS Code client: survival protocol decides; fallback peaceful-ocean (never a new tunnel).
- Codex hooks need a one-time interactive trust (per-hook hash in `config.toml`, algorithm unknown): status degrades to transcript mtime until the operator opens `codex` once.
- Gemini hook container shape inferred; `--resume <index>` ordering assumed `startTime` asc: fallback `latest`, "best-effort" note on older rows.
- Cursor desktop resume may be refused: honest banner + new agent (decision 3). `cursor-agent ls` needs an unlocked keychain: Garrison-owned panes run under the GUI session on the mini; document it.
- CORS broadened to any trusted-host Origin and the fitting has no token (same posture as the shell and dev-env): confined to this fitting; `/exec` + `/agent-turns` refuse browsers.
- Stationing cursor-runtime changes the up fingerprint on every node: the degraded probe keeps nodes without cursor-agent green; a node that should run Cursor sets `GARRISON_REQUIRE_CURSOR=1`.
- Index build cost on large `~/.claude/projects`: bounded (`maxScan`, 5-day window); raise `index_publish_seconds` if > 1 s.
- `localExec` prelude bypassed by `env`/`xargs`/`nohup tmux`: guarded by the grep test.
- csg composition `up` may still fail verify for something not in the unstation list: extend `local.yml`, re-run; worst case csg is a shells-only node (no session host) and the ledger says so.
- Corporate proxy / clock drift / WSL lifetime on csg: `NO_PROXY`, `hwclock -s` in the supervisor, the supervised node process keeps WSL alive; a full WSL shutdown needs one WSL terminal opened by the operator.
- The two `.next` dist dirs and `reuseExistingServer:false`: never run the two Playwright configs concurrently or while the node server owns `.next/`.

## 7. Docs to update at the end (F2)

`docs/decisions/2026-09-03-shells-and-mesh-sessions.md` (complete), CLAUDE.md terminology (Shells fitting, Sessions
in Conversations, tethered node, `local.yml unstation`), `docs/INSTANCES.md` (tethered node + serve exceptions),
`fittings/seed/remote-shell-runtime/apm.yml` `for_consumers`, `docs/UI-FITTINGS.md` if the file-sets descriptor
belongs there. Memory note in `~/.claude/projects/-home-ggomes-dev-garrison/memory/` (shells build: the traps found).

## 8. Out of scope (recorded, not built)

OpenCode session lister (sqlite store); a `cursor-config` mirror fitting (rules synced across nodes like
`claude-config`); Claude peer-messaging socket (`~/.claude/sessions/*.key`, `cc-socks`) as a chat lane into an external
interactive session; dev-env/shells consolidation; service-principal `devtunnel` login.

## 9. RUN PROTOCOL (multi-model; follow literally)

Roles: IMPLEMENTER = Sonnet 5. REVIEWER = Fable 5.1 or Opus 5 (operator picks at STOP 1). E2E = Opus 5 with
claude-in-chrome. The operator switches the model at each STOP; the session context continues. Work on the
current branch (`main` on dev-madrid); never create a branch; push straight to main (the "Bypassed rule
violations" line is expected). Commit per gate with a message naming the gate. Keep
`evidence/shells/PROGRESS.md` (section 10) current BEFORE and AFTER every gate; on resume after a model switch or
compaction, read the plan, then the ledger's "Resume here", and continue from there without re-planning.

Gate order: G0 -> G1 -> G2 -> (rollout to the mini) -> G3 -> G4 -> G5 -> (rollout) -> G6 -> G7 -> G8 -> STOP 1.
G7/G8 run only when the G6 preflight verdict is GO or GO-WITH-FIXES and csg is reachable; otherwise mark them
`skipped: <reason>` and continue to STOP 1. If the `devtunnel` login on dev-madrid has expired, the preflight
stops: call AskUserQuestion "devtunnel login expired on dev-madrid. Run `devtunnel user login -g -d` in a terminal,
then answer Done" and re-run.

Per-gate definition of done: (1) `npm run typecheck && npm run lint && npx vitest run <gate suites>` green, summary
lines pasted into the ledger; (2) commit; (3) restart per CLAUDE.md discipline (`node:reload` for app-only,
`node:redeploy` when `fittings/seed/**`, `packages/**`, `compositions/*/apm.yml` or a long-lived script changed),
then `curl -sf http://127.0.0.1:8777/api/mesh/self` and `curl -sf http://127.0.0.1:8098/health` both 200, verb + time
in the ledger; (4) evidence under `evidence/shells/<gate>/` from `https://dev-madrid.tail31efa.ts.net` (never
localhost), committed; (5) ledger row `done`. Engage the design bar for G3/G4/G5 UI work: Fortress palette from
`packages/talk/ui/styles.css`, 8 px grid, 44 px targets on coarse pointers, no emoji, testids on every interactive
element, both 1440x900 and 390x844 checked before calling a gate done.

STOP 1 (after G8 or the csg skip): AskUserQuestion, question "All implementation gates are done (see
evidence/shells/PROGRESS.md). Review before E2E?", options "Review with Fable 5.1" / "Review with Opus 5" / "Skip
review, go to E2E". Then STOP (end the turn). Do not continue implementing.

STOP 2 (REVIEW, only if chosen; the operator has switched the model): fresh-eyes review in the style of
`garrison-adversarial-review`: read ONLY this plan, the ledger, and `git diff <G0-parent>...HEAD`; run typecheck,
lint, vitest yourself; curl the live endpoints; write `evidence/shells/review/findings.md` as `F-xxx` lines
(severity, file:line, evidence command + output, the plan section violated); append them to the ledger's Open
findings; commit. Then AskUserQuestion "Review done: <n> findings (<blocking>/<minor>). Switch to Sonnet 5 to fix?",
options "Switch to Sonnet" / "Discuss a finding first". STOP.

STOP 3 (F1, Sonnet): fix every open finding or mark `wontfix:<why>`; commit per finding or file cluster;
reload/redeploy per discipline; re-run affected suites; retry the csg preflight if G6 was blocked (run G7/G8 if it
now passes); update the ledger. AskUserQuestion "Findings fixed (<n> fixed, <m> wontfix). Switch to Opus 5 for
exploratory E2E?", options "Switch to Opus" / "Run another review round". STOP. (If review was skipped at STOP 1,
go straight to STOP 4's instruction: AskUserQuestion "Switch to Opus 5 for exploratory E2E?" and STOP.)

STOP 4 (E2E, Opus with claude-in-chrome; load the tools in ONE ToolSearch call): exploratory testing against the
LIVE nodes, never localhost. URLs: `https://dev-madrid.tail31efa.ts.net/talk` (Sessions, panes), `/mesh`,
`/quarters/cursor-runtime/*`, `/muster`; the mini `https://goncalos-mac-mini-1.tail31efa.ts.net/talk` and
`/quarters/cursor-runtime/rules`; csg if G8 is done (`https://dev-madrid.tail31efa.ts.net:8977/`,
`:8998/health`). Use `resize_window` 1440x900 and 390x844 for every flow. Flows: list refresh while a real
`claude`/`codex` session works (start one from a terminal via Bash, watch the pulse appear within 10 s and clear after
it stops); open an owned shell and type into the pane; composer send + key chips; New shell in a project on
dev-madrid and on the mini; transcript of an external session (Claude here, Cursor desktop on the mini); Continue on a
Cursor desktop row (record what Cursor did); peer rows for every node; node switch (incl. csg when present); csg attach;
state service restart (`systemctl --user restart garrison-state`) and the recovery banner; Quarters rules autosave
on the mini. Vision checklist per screenshot (pass/fail each): 8 px grid alignment, node dots use the palette hex,
Working badge + pulse readable at both sizes, serif titles, no clipped text at 390 px, xterm shows no partial last
row and no double scrollbar, touch scroll moves history not the page, focus rings visible, empty and error states
carry copy, muted text contrast >= 4.5:1 (measure with `javascript_tool` getComputedStyle), no loading flashes,
safe-area respected. Read `read_console_messages` and `read_network_requests` on every page. Screenshots to
`evidence/shells/e2e/<flow>-<viewport>.png`; findings to `evidence/shells/e2e/findings.md` (`F-xxx` with screenshot
name + console/network errors); commit. AskUserQuestion "E2E done: <n> findings. Switch to Sonnet 5 to fix and write
the specs?", options "Switch to Sonnet" / "Explore more first". STOP.

STOP 5 (F2, Sonnet): fix the E2E findings (commit per finding, reload/redeploy); write the Playwright specs of
section 5 from the E2E learnings (every finding that was a real bug gets an assertion); run
`npx playwright test -c playwright.web-channel.config.ts` and `npx playwright test tests/e2e/quarters-cursor.spec.ts`
green; full `npm test` green; docs of section 7; final commit; `npm run node:redeploy` on dev-madrid, the mini
rollout of section 4, `bash scripts/remote-shell/csg-node-redeploy.sh redeploy` if csg is enrolled; evidence in
`evidence/shells/final/` (Playwright report, `/mesh` roster screenshot); ledger FINAL row; print the ledger. Done.

## 10. Ledger format (`evidence/shells/PROGRESS.md`)

```
# Shells run ledger
plan: /home/ggomes/.claude/plans/we-should-have-a-zesty-star.md   model: <id>   branch: <name>   head: <sha>
| gate | status (todo/doing/done/blocked/skipped) | commit | deploy (reload|redeploy @ ISO) | evidence dir | notes |
## Mesh heads
dev-madrid <sha> @ ISO | mini <sha> @ ISO | csg <sha or n/a>
## Resume here
<the exact next command or step, one paragraph>
## Open findings
F-001 [source: review|e2e] [status: open|fixed:<sha>|wontfix:<why>] <one line>
```

## Appendix A. Research findings (verified 2026-09-03)

Session stores: Claude Code 2.1.25x live registry `~/.claude/sessions/<pid>.json` `{pid, sessionId, cwd,
startedAt, procStart, status: busy|idle|shell, name, kind, entrypoint, messagingSocketPath, bridgeSessionId}` (stale
pids linger; `claude agents --json`, `claude attach <id>`, `claude logs <id>`, `claude --resume <id>` forks a copy of a
live session); transcripts `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (`claudeProjectDirForCwd`), latest
`ai-title` near EOF. Codex 0.149 `~/.codex/session_index.jsonl {id, thread_name, updated_at}`, rollouts
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl` (`session_meta.payload {id, session_id, cwd,
originator, cli_version, thread_source, source}`), extra homes under `~/.garrison/runtime-homes/codex` and
`~/.garrison/marathon/codex-home`; `codex resume <uuid>`; hooks `Stop, UserPromptSubmit, PreToolUse, PostToolUse,
SessionStart, SessionEnd, TurnStart, SubagentStop, PreCompact` with per-hook trust in `config.toml`. Cursor (mini)
`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` (desktop composer AND CLI chats, live-updating,
`{role, message:{content:[{type:text|tool_use}]}}`), `~/.cursor/chats/<ws>/<id>/{meta.json, store.db}`, desktop
titles in `state.vscdb` `cursorDiskKV composerData:<id>`, `~/.cursor/{rules/*.mdc, skills, agents, mcp.json,
cli-config.json}`, no `hooks.json` yet; `cursor-agent` at `~/.local/bin` (login shell only), `cursor-agent ls` needs
an unlocked keychain. Gemini 0.52 `~/.gemini/projects.json`, `~/.gemini/tmp/<name>/chats/session-*.jsonl`,
`--list-sessions`, `--resume <index|latest>`, `gemini hooks migrate`. Instance homes: `CODEX_HOME`, `GEMINI_CLI_HOME`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME` (`scripts/garrison-instance.sh:160-165`).

csg: WSL Ubuntu on Windows `AZR-IMvwYA5CQHr` (also enrolled on the tailnet as `azr-imvwya5cqhr-1`, offline), user
`ggomes`, `~/dev/pnmui-monorepo`, sshd 2222 key-only (`~/.ssh/garrison-remote-shell`), tmux sessions `csg`,
`ui-sms-ws`, `pnmui-monorepo{,-2,-3}`, hooks -> `~/.garrison/events.jsonl` (csg-bootstrap.sh); transport today =
`peaceful-ocean-zcx3mqx.eun1` (label `garrison-csg-ssh`, needs `devtunnel host` on csg, `host-tunnel.sh`
supervisor); VS Code tunnel `swift-book-df6tw47.eun1` has ports 2222, 31545, 31546; both unhosted tonight;
`devtunnel` GitHub login on dev-madrid expires within a day.

Code map: `packages/talk` (`router.mjs handleThreadsList` folds three liveness sources; rail reads
`Boolean(runningSince)`; list never self-refreshes; `/remote-shell/io` WS relay only in the legacy own-port host;
`findTranscriptBySession`, `/api/session-stream`, `session-transcript.mjs parseTranscriptLines`;
`thread-registry.mjs`/`mesh-threads.mjs` doc pattern); `packages/claude-pty` (`spawnClaudePty`, `screen.mjs
isWorking`, `openRichStream`, `paths.mjs`); dev-env (`ptys.mjs`/`tmux.mjs` tmux-attach clients on `-L garrison` /
`$GARRISON_HOME/tmux/dev-env.sock`, `/io` protocol, `claude-sessions.mjs`); `remote-shell-runtime` (`transports.mjs`
TunnelManager/describeTunnel/sshArgv, `sessions.mjs` single `#exec` seam + attach + events tail + storm recovery +
persist, `forwards.mjs`, `remote-files.mjs`, `tunnel-health.mjs`, `host-credential.mjs`, `server.mjs` routes,
`remote-shell-adapter.mjs` TUI/exec lanes); mesh (`services/state` bearer-per-node, `config_docs`, `POST /v1/hello`
beat from `scheduler/scripts/lib/node-beat.mjs`, `packages/garrison-state-client` + generated mirrors via
`scripts/sync-state-client.mjs`, `/api/mesh/nodes` `mergeMeshRoster`, `readSelfSnapshot`, `NodeSwitcher`,
`node-switch.ts nodeAppOrigin`, `peer-proxy.ts` closed ALLOW table, `peer-auth.ts isTrustedHost`, serve-port
`8400 + port%1000`, `tailnet-serve.ts`, `resolveViewUrl`, `install-node.sh` tailscale-required); runtimes
(`cursor-runtime` adapter + `link-config-home.mjs` + generic `quarters_descriptor`, NOT stationed; gateway
`EXEC_ADAPTER_CLASS`; `PRIMARY_CONTEXT_FILES.cursor = AGENTS.md`; `projectPrimaryContext` refuses to clobber unmarked
files); Quarters (`quarters-runtimes.ts` generic tier, `RuntimeGenericPanels.tsx`, `expandHome` without override);
runner (`verify()` failure aborts `up()`; `platforms` = model platform; `local.yml` = config values only); tests
(vitest workspace, `.mjs` shims, Playwright base + web-channel configs, `startTalkApp`, sandbox seeding,
`vocabulary`/`instance-isolation`/`mesh-serve-ports` guards; `.gitignore` ignores `evidence/*` except negated dirs).
