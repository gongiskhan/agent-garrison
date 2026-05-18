# Sequoias — build prompt

A local desktop dashboard for managing parallel Claude Code sessions across git worktrees, for a single Mac user (me). Read this entire document before writing a single line of code. The success criterion is **one self-contained build that passes the test plan in section 9 on the first run**. Stop and ask before deviating from anything in section 4 (non-goals) or section 6 (data model).

---

## 1. What we're building

A Node.js application called **Sequoias** that:

1. Runs locally as a process (`npx sequoias` or `pnpm start`).
2. Serves a web UI at `http://localhost:7777` (configurable).
3. Discovers and monitors all my Claude Code sessions across git worktrees.
4. Lets me create new worktrees with auto-allocated, conflict-free ports.
5. Lets me create PRs from any worktree with one click.
6. Embeds a terminal per session (xterm.js + node-pty) so I never leave the UI.
7. Shows live status per session: **Working**, **Waiting** (needs input), **Idle**, **Errored** — derived from Claude Code's official hook events.

Single user. macOS only. No auth. No telemetry. Local JSON persistence at `~/.sequoias/state.json`.

---

## 2. Why this name

Sequoias are big trees that grow in groves. Each Claude Code session is a tree; the dashboard is the grove. The metaphor is internally consistent with worktrees without being twee.

---

## 3. Inputs the tool takes

A single CLI invocation:

```bash
sequoias /path/to/project          # required: path to a git repo
sequoias /path/to/project --port 8888
sequoias /path/to/project --ide rebased    # path/command for IDE launch button (optional)
```

The repo path is the *main checkout*. Worktrees live at `~/.worktrees/<repo-name>/<branch-slug>`. No config file in the repo. Nothing committed. Nothing about Sequoias touches the repo's tracked files.

---

## 4. Non-goals (DO NOT DO THESE)

These were considered and explicitly rejected. If you find yourself wanting any of these, **stop and ask first**.

- **No `.wt.config` file.** Auto-discover env files; rewrite ports automatically (see §7).
- **No multi-user / auth / cloud sync.** Localhost only.
- **No Electron or Tauri.** Plain Node.js + a browser UI. The user opens it in their normal browser.
- **No tmux.** xterm.js panes in the UI, period. The user explicitly rejected tmux for this.
- **No project plugin system, no extensibility, no MCP server, no faculties.** Those belong in Garrison; this is the prototype that informs Garrison's Workspace primitive later.
- **No database.** Just a JSON file at `~/.sequoias/state.json` plus the live in-memory session map.
- **No tests for the UI's visual styling.** Functional tests via Playwright only — see §9.
- **No auto-merge, no auto-fix, no AI-assisted PR descriptions.** Manual `gh pr create` only.
- **No mobile UI, no QR code, no Tailscale integration.** Future. Not now.

---

## 5. Architecture

```
sequoias/
├── package.json
├── src/
│   ├── server.ts            # Express + WebSocket entry
│   ├── ports.ts             # Port allocation (FNV-1a hash + lsof probe)
│   ├── env-rewriter.ts      # Discover & rewrite env files
│   ├── worktree.ts          # git worktree create/remove/list
│   ├── git-ops.ts           # branch ops, PR creation via `gh`
│   ├── pty-manager.ts       # node-pty session lifecycle
│   ├── claude-hooks.ts      # Receive Claude Code hook events
│   ├── status.ts            # Status state machine per session
│   ├── store.ts             # JSON persistence
│   └── routes.ts            # HTTP + WS routes
├── ui/
│   ├── index.html
│   ├── main.tsx             # React app
│   ├── components/
│   │   ├── SessionList.tsx
│   │   ├── SessionCard.tsx
│   │   ├── Terminal.tsx     # xterm.js wrapper
│   │   ├── NewSessionDialog.tsx
│   │   └── StatusBadge.tsx
│   └── styles.css
├── tests/
│   ├── e2e/
│   │   └── full-flow.spec.ts
│   └── fixtures/
│       └── fake-repo/       # generated in test setup
└── README.md
```

**Stack:**
- Node 20+, TypeScript
- Express for HTTP, `ws` for WebSocket
- `node-pty` for terminal sessions
- React 18 + Vite for the UI (single bundle, served by Express in production)
- xterm.js + xterm-addon-fit for terminals
- `simple-git` for git ops
- `execa` for shelling out (`gh`, `lsof`)
- Playwright for tests
- No CSS framework — plain CSS with a design tokens file. Sober palette. **Do not generate "AI slop" — see UI notes in §8.**

---

## 6. Data model (`~/.sequoias/state.json`)

```ts
type State = {
  version: 1;
  projects: Record<string, Project>;  // keyed by absolute path
};

type Project = {
  path: string;             // absolute path to main checkout
  name: string;             // basename(path)
  ide?: string;             // CLI command to launch IDE, e.g. "rebased"
  sessions: Record<string, Session>;  // keyed by branch name
};

type Session = {
  branch: string;
  worktreePath: string;     // ~/.worktrees/<repo>/<slug>
  ports: Record<string, number>;  // { cortex: 4143, ekoa_app: 5226, ... }
  envFiles: string[];       // relative paths that were rewritten
  createdAt: string;        // ISO
  ptyId?: string;           // current pty id if alive
  lastStatus: SessionStatus;
  lastStatusAt: string;
  lastHookEvent?: string;   // raw hook name from Claude Code
};

type SessionStatus =
  | 'starting'    // pty spawned, claude not yet started
  | 'working'     // claude is processing
  | 'waiting'    // claude is waiting for user input (Notification hook fired)
  | 'idle'        // claude is at prompt, no work pending (Stop hook fired)
  | 'errored'     // pty exited non-zero or hook reported error
  | 'dead';       // pty has exited
```

Persist on every state change; load on startup. If the worktree directory has been deleted manually, mark the session `dead` and leave it for cleanup.

---

## 7. Behavior specs

### 7.1 Port allocation

Identical to the proven `wt` script approach:

- Hash `<branch>:<service>` with FNV-1a 32-bit.
- Modulo into a per-service range. Defaults: `cortex 4000-4999`, `ekoa_app 5000-5999`, plus a discovered-services range starting at 6000 in 1000-port blocks.
- Probe each candidate port with `lsof -iTCP:<port> -sTCP:LISTEN -t`. Linear-probe up to 50 forward.
- Same branch + same service = same port, every time. This is critical.

### 7.2 Env file discovery and rewriting

**No `.wt.config`. Auto-discover.** On worktree create:

1. Scan the main checkout for files matching `.env`, `.env.*`, `**/.env`, `**/.env.*` — but only inside directories that exist in the worktree (skip `node_modules`, `dist`, `.git`, `.next`, `build`, anything in `.gitignore`).
2. For each discovered env file, copy to the worktree.
3. Inside each copied file, scan for known port-shaped keys and rewrite them:
   - `PORT`, `*_PORT`, `*_PORT_*` → match against allocated services by name. If a key contains `cortex` (case-insensitive), it gets the cortex port. If it contains `next`, `app`, or `frontend`, it gets the ekoa_app port. Otherwise allocate it a fresh service named after the key prefix.
   - Any URL-shaped value containing `localhost:<port>` or `127.0.0.1:<port>` → if `<port>` matches a known main-checkout port (read once at startup from main's env files), replace with the corresponding worktree port.
4. Do not append keys that weren't already in the file. Per-file scope — never cross-pollinate keys between files.
5. Write a `.sequoias-meta.json` at the worktree root recording branch + ports + which env files were touched.

### 7.3 Session lifecycle

1. **Create:** user clicks "New session", types a branch name, optionally picks a base branch (default: main).
2. Server: create branch + worktree, allocate ports, copy/rewrite envs, write meta.
3. Spawn a pty: `cd <worktreePath> && claude` (the user is already authenticated; no flags).
4. Register hook receiver for this pty (see §7.4).
5. Stream pty output over WebSocket to the UI, where xterm.js renders it.
6. User types in the terminal in the UI; input goes back over WebSocket to the pty.

### 7.4 Status detection via Claude Code hooks

This is the part everyone gets wrong. Don't use output-string heuristics. Use **Claude Code's hook events**.

Claude Code reads hook config from `~/.claude/settings.json` (or `.claude/settings.json` in the project). On Sequoias startup, **write a hook config** that fires a small shell command on the events we care about. The command POSTs to Sequoias's local HTTP endpoint with the session's working directory and the event name.

Hooks to register:

- `UserPromptSubmit` → status = `working`
- `Stop` → status = `idle`  (Claude finished a turn)
- `Notification` → status = `waiting` (Claude is waiting for user permission/input)
- `SubagentStop` → no status change, but log
- `PreToolUse` / `PostToolUse` → no status change, but useful for "currently using tool X" hover info

The hook command format (write this exactly):

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "curl -s -X POST http://localhost:7777/_hook -H 'Content-Type: application/json' -d \"{\\\"event\\\":\\\"UserPromptSubmit\\\",\\\"cwd\\\":\\\"$CLAUDE_PROJECT_DIR\\\"}\""}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "curl -s -X POST http://localhost:7777/_hook -H 'Content-Type: application/json' -d \"{\\\"event\\\":\\\"Stop\\\",\\\"cwd\\\":\\\"$CLAUDE_PROJECT_DIR\\\"}\""}]}],
    "Notification": [{"hooks": [{"type": "command", "command": "curl -s -X POST http://localhost:7777/_hook -H 'Content-Type: application/json' -d \"{\\\"event\\\":\\\"Notification\\\",\\\"cwd\\\":\\\"$CLAUDE_PROJECT_DIR\\\"}\""}]}]
  }
}
```

Sequoias must:
1. On startup, **non-destructively merge** these hooks into `~/.claude/settings.json` (preserve any existing hooks the user has). Tag our hooks with a comment marker like `"_sequoias": true` so we can identify and remove them on shutdown.
2. On shutdown, remove the Sequoias-tagged hooks. Use `process.on('SIGINT')` and `process.on('SIGTERM')`.
3. The `/_hook` endpoint matches incoming `cwd` against active sessions by `worktreePath` and updates status.
4. Fallback: if no hook event has been received for a session in 60s and the pty has output recently, mark `idle`. This handles the rare case where hooks fail.

### 7.5 PR creation

Single button per session card: "Create PR".
- Confirms the branch is pushed; if not, `git push -u origin <branch>` first.
- Runs `gh pr create --base main --head <branch> --fill`.
- On success, surfaces the PR URL in the UI as a clickable link on the session card.
- On failure (gh not authed, network, etc.), shows the stderr in a toast.

### 7.6 Worktree removal

"Archive" button per session card:
1. Confirm dialog ("Remove worktree? Branch will be kept.").
2. Kill pty if alive.
3. `git worktree remove --force <path>`.
4. Remove from state.
5. Optional checkbox in dialog: "also delete branch" — runs `git branch -D`.

### 7.7 IDE launch

If `--ide <cmd>` was passed at startup, show a "Open in IDE" button on each session card that runs `<cmd> <worktreePath>` via execa. No-op if not configured.

---

## 8. UI notes

Goal: looks like a tool, not a SaaS landing page. Keep it sober.

- **Layout:** left rail with session cards (sorted: waiting → working → idle → errored → dead). Main pane shows the selected session's terminal full-height.
- **Session card content:** branch name (large), status badge with colored dot, ports as a compact line (`cortex:4143  app:5226`), 4 icon buttons: open-in-IDE, create-PR, archive, focus-terminal.
- **Status badge colors:** waiting = amber + pulsing dot; working = green + spinner; idle = neutral gray; errored = red; dead = dim gray.
- **New-session button:** prominent at top of left rail. Opens a dialog with branch input and base-branch dropdown (populated from `git branch -a`).
- **No emojis in the UI chrome.** Use lucide-react icons.
- **Dark mode by default.** Single theme. Don't build a toggle.
- **Typography:** system font stack. Mono font for ports, paths, branch names.
- **Density:** tight. This is a power tool, not a marketing page. No big hero spacing.

---

## 9. Test plan (PLAYWRIGHT — must pass before claiming done)

Use Playwright with the Node.js test runner. The tests bootstrap a fake git repo in a temp dir, start the server on a random port, and exercise the full flow. **All assertions must use `await expect(locator).toHaveText(...)` or `toBeVisible()` — no sleeps.**

### Setup helper (`tests/fixtures/fake-repo.ts`)

```ts
// Creates a temp git repo with:
// - an initial commit on main with .env files at root, ./cortex/.env, ./ekoa-app/.env
// - sample env keys: PORT, CORTEX_PORT, NEXT_PUBLIC_CORTEX_URL, NEXT_PUBLIC_PORT
// Returns { repoPath, cleanup }
```

### Test cases (must all pass, run with `pnpm test:e2e`)

1. **Boots and serves UI** — starts server pointing at fake repo, navigates to `http://localhost:<port>`, expects the project name visible in the header.

2. **Creates a session with allocated ports** — clicks "New session", types `feature/auth`, submits. Within 5s a session card appears with status `starting` or `working`, ports rendered, and a worktree directory exists at `~/.worktrees/<repo>/feature-auth`.

3. **Env files are rewritten correctly** — after creation, read the worktree's `cortex/.env` and assert `PORT` was changed from main's value, and `cortex/.env` does NOT contain `NEXT_PUBLIC_PORT` (per-file scope test).

4. **Same branch produces same ports across recreate** — record ports, archive session, recreate same branch, assert identical ports.

5. **Different branches produce different ports** — create `feature/a` and `feature/b`, assert their port maps don't overlap.

6. **Hook event flips status to idle** — manually POST to `http://localhost:<port>/_hook` with `{event:"Stop",cwd:"<worktreePath>"}`, assert UI badge updates to "idle" within 2s (poll the badge text via Playwright).

7. **Hook event flips status to waiting** — POST `Notification` event, badge becomes "waiting" within 2s.

8. **Sessions sort by priority** — given two sessions, send `Notification` to one and `Stop` to the other; assert the waiting one appears first in the left rail.

9. **PR button calls gh** — mock `gh` by putting a fake script in PATH that prints a fake PR URL; click "Create PR"; assert URL appears as link on card. (Use `process.env.PATH` override scoped to the spawned server process.)

10. **Archive removes session and worktree** — click archive, confirm, assert session card disappears, assert directory no longer exists, assert state.json no longer contains the session.

11. **Hooks installed and removed cleanly** — before starting server, snapshot `~/.claude/settings.json` (or note its absence). Start server, verify Sequoias hooks present. Stop server (SIGTERM). Verify settings.json is byte-identical to snapshot.

12. **Survives restart with sessions intact** — create session, kill server, restart server with same project path, assert session card reappears with same branch/ports (status will reset to `dead` until pty respawns; that's fine for v1).

13. **No port collision with already-bound port** — manually bind a port that the hash would assign; create session; assert allocator linearly probes and assigns a different port.

14. **Terminal IO round-trips** — open terminal pane, type `echo hello-from-test` into the xterm via Playwright's keyboard, assert output appears in the terminal. (This is the only xterm assertion; visual rendering not tested further.)

### Manual sanity check (one paragraph in README, not automated)

After `pnpm start`, open the UI, create one real session, run `claude` in it, ask it "what's 2+2", confirm status moves working → idle as Claude responds. This is the smoke test no automation can fully replace.

---

## 10. README content

Write a `README.md` covering: what it is (one paragraph), install (`pnpm install && pnpm build`), run (`pnpm start /path/to/project`), the four behaviors a user actually does (create session, switch between sessions, create PR, archive), and the manual sanity check from §9.

Keep it short. No marketing language. No screenshots in v1.

---

## 11. Acceptance criteria

You are done when:

1. `pnpm install && pnpm build && pnpm start /path/to/fake-repo` works on a clean macOS machine with Node 20+, gh, and claude installed.
2. `pnpm test:e2e` passes all 14 cases in §9 with no flakes across 3 consecutive runs.
3. `~/.claude/settings.json` is restored to its original state after the server is stopped (test #11 covers this — verify by hand once too).
4. The UI does what §8 says, no more.
5. A new commit on a session worktree, followed by Create PR, produces a real PR on GitHub (manual check).

**Do not claim done before all 14 tests pass.** If a test is flaky, fix the test or the underlying race — do not retry-loop your way past it.

---

## 12. Order of work (suggested)

1. Skeleton: package.json, tsconfig, Vite, Express server serving an empty UI shell. `pnpm start` boots, UI loads.
2. State store + project loading from CLI arg.
3. Port allocator + env rewriter (with unit tests in `tests/unit/`).
4. Worktree create/remove (no UI yet — drive via a temporary route, verify with curl).
5. UI: session list + new session dialog. Wire to backend. Test #2-5 should pass here.
6. PTY manager + WebSocket terminal. Test #14.
7. Hook installer + receiver + status state machine. Test #6, #7, #11.
8. PR + archive + IDE launch buttons. Test #9, #10.
9. Persistence + restart. Test #12.
10. Polish: sorting, status badges, error toasts. Test #8, #13.
11. README.

---

## 13. Things you'll want to look up while building

- Claude Code hook reference: `https://docs.claude.com/en/docs/claude-code/hooks` (use web fetch if you need the exact event payload schemas — `UserPromptSubmit`, `Stop`, `Notification`, `SubagentStop`, `PreToolUse`, `PostToolUse`).
- node-pty: spawn shape and resize handling.
- xterm.js fit addon: ensure terminal resizes when the right pane resizes.
- `gh pr create`: confirm `--fill` works without `gh` prompting interactively.

---

That's the whole spec. Build it. Don't ask me clarifying questions before §9 passes — every answer you'd want is already in this document. If you hit a real blocker (e.g. a Claude Code hook event doesn't behave as documented), document the divergence in the README and continue.
