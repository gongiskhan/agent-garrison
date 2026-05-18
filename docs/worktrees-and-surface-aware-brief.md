# Brief: Worktrees, Ports, and Surface-Aware Orchestration

**Status:** Active implementation brief
**Target implementer:** Claude Code (Opus)
**Builds on:**
- Gateway Faculty — Stream-JSON Consolidation brief
- Orchestrator, Souls, and Multi-Session Architecture brief

**Does not touch:** The existing tier classifier and its integration with Workbench terminals and the Worktrees area. That work stays. The orchestrator becomes an additional consumer of the same tier classifier, not a replacement for it.

---

## Context

The current Garrison implementation has two parallel flows for kicking off coding work:

1. **Orchestrator → headless Claude Code session** — works for channel input (mobile, external), built in the previous brief.
2. **Workbench terminal / Worktrees area → tier-classified Claude Code TUI** — built more recently; user starts work directly from a terminal or worktree row, the tier classifier picks the model/effort, Claude Code runs in TUI in the workbench.

These need to converge under the orchestrator while preserving both surfaces. The orchestrator should:

- Be aware of **worktree state** — creating new worktrees for new tasks, reusing existing ones for continuations.
- Allocate **ports** per worktree and surface **Tailscale URLs** so running services are reachable from any device.
- Behave differently based on **request origin**: channel-origin requests spawn headless sessions; workbench-origin requests spawn TUI sessions in the workbench terminal.
- Re-use **the existing tier classifier** to pick model/effort/testing/etc. before spawning.
- Manage **session tier transitions** by killing and resuming with new flags when the required tier changes mid-conversation, preserving context.

## Decisions

1. **One orchestrator per user, origin-tagged turns.** A single orchestrator session holds cross-surface context. Each turn carries `origin: "workbench" | "channel"` metadata. The orchestrator's `talk_to` defaults to that origin's spawn mode but can override.

2. **Worktrees are a first-class Garrison entity.** Tracked in a worktree registry: name, project, branch, cwd, ports, URLs, active sessions, status. Created and looked up by the orchestrator via MCP tools.

3. **Port allocation is a Garrison service.** A configurable port pool (default `3000–3100`). Each worktree reserves a contiguous range based on the project's port-needs declaration. Reservations release when the worktree is merged/discarded.

4. **Tailscale URLs are constructed automatically.** Garrison resolves the local Tailscale hostname once at startup and builds `https://<host>:<port>` URLs for every reserved port. URLs appear on the session row in the UI and in `talk_to`'s tool-result so the orchestrator can mention them.

5. **Channel-origin spawn = headless stream-JSON.** As built in the prior brief. No change.

6. **Workbench-origin spawn = TUI in a workbench terminal tab.** Gateway opens a new terminal tab in the workbench, runs `claude` with appropriate flags (no `--print`, no stream-JSON), types the initial prompt via the PTY, then steps back. The user can continue interactively. The orchestrator reads summaries from the session's JSONL on disk after each turn.

7. **Tier-aware respawn.** Each session tracks its current tier (`{model, effort, needs_testing, ...}`). When the orchestrator wants to send new work to an existing session and the required tier differs, the Gateway kills the current process and re-spawns with the new model/effort flags using `--resume <session-id>` (preserves context). Works identically in both spawn modes.

8. **Tier classifier is reused, not rebuilt.** The orchestrator calls into the existing classifier through a new `garrison-control` MCP tool: `classify_tier(task_description, project_hints?) → {model, effort, needs_testing, needs_agents_team, ...}`. The classifier itself is untouched.

9. **PR on completion, not auto-merge.** When the user confirms a worktree's work is done, the Gateway opens a PR (via `gh pr create` or equivalent) rather than merging directly. Visibility over speed for v1.

---

## Architecture additions

```
┌──────────────────────────────────────────────────────────────────┐
│                   Garrison Desktop UI                            │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Orchestrator chat        │   Worktrees area              │    │
│  │  "fix the regex bug"      │   ┌──────────────────────┐    │    │
│  │  → engineer in            │   │ feat/regex-fix       │    │    │
│  │    worktree feat/regex-fix│   │   :3001 [open]       │    │    │
│  │    @ :3001                │   │   engineer (tier: M) │    │    │
│  │                           │   └──────────────────────┘    │    │
│  └──────────────────────────────────────────────────────────┘    │
│  Workbench terminal tab (auto-opened):                           │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ $ claude --resume <uuid> --model sonnet ...              │    │
│  │ > fix the regex bug in LoginForm validation              │    │
│  │ [TUI interactive — user can take over]                   │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Garrison Gateway                           │
│                                                                  │
│  Services:                                                       │
│   - Session registry (with mode, tier, worktree binding)         │
│   - Worktree registry                                            │
│   - Port allocator (pool: 3000-3100)                             │
│   - Tailscale URL resolver                                       │
│   - Tier classifier (existing, reused)                           │
│                                                                  │
│  MCP server (garrison-control), exposed to orchestrator only:    │
│   - talk_to, wait_for, list_active_sessions, end_session  (v1)   │
│   - + classify_tier                                       (new)  │
│   - + list_worktrees, create_worktree, get_worktree       (new)  │
│   - + open_pr, close_worktree                             (new)  │
│                                                                  │
│  Workbench API (for desktop UI):                                 │
│   - POST /workbench/terminals — open new tab                     │
│   - POST /workbench/terminals/:id/input — type into PTY          │
│   - GET  /workbench/terminals/:id/stream — SSE for read          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Surface (origin) awareness

### How origin is determined

- Requests over `POST /chat` (or `POST /chat/stream`) from the **Garrison desktop UI** carry header `X-Garrison-Origin: workbench`.
- Requests from **mobile/external channels** carry header `X-Garrison-Origin: channel` (or absence of header, which defaults to `channel`).
- The Gateway tags each turn fed to the orchestrator with this origin in the user message metadata. The orchestrator sees it as a small prefix block in the user message:
  ```
  [origin: workbench, channel: main]
  fix the regex bug in LoginForm validation
  ```

The orchestrator's system prompt is updated to acknowledge this prefix and to default `talk_to`'s mode based on it.

### How origin selects spawn mode

When the orchestrator calls `talk_to`, the Gateway:

1. Reads the orchestrator's current-turn origin (set by the Gateway when it fed the turn).
2. Reads any explicit `mode` argument on `talk_to` (overrides origin).
3. Resolves to one of:
   - **`headless`** (default for `channel` origin): spawn `claude --print --output-format stream-json --input-format stream-json --session-id <uuid> ...` as before. Output streams to the channel.
   - **`workbench`** (default for `workbench` origin): open a new terminal tab in the workbench, spawn `claude --session-id <uuid> ...` in TUI mode, type the prompt over PTY. User can interact.

The orchestrator does not need to think about mode unless overriding. Examples of when it might override:
- "Run this in the background, no terminal" → `mode: "headless"` even from workbench
- (Channel origin can't sensibly override to `workbench` since there's no workbench surface from mobile; the override is silently ignored or returns an error.)

### Workbench-mode spawn details

Steps the Gateway executes when `mode = "workbench"`:

1. Resolve the worktree (see worktree section). Get its cwd.
2. Allocate or reuse the worktree's session for the Soul.
3. Open a new workbench terminal tab via `POST /workbench/terminals` with `cwd` set to the worktree path.
4. In that tab's PTY, run:
   ```
   claude \
     --resume <session-id>           # or no --resume for fresh
     --model <tier.model> \
     [--append-system-prompt-file <soul>/system-prompt.md] \
     [--allowedTools / --disallowedTools] \
     [other tier-derived flags]
   ```
5. Once Claude Code's TUI is ready, type the prompt via PTY input:
   ```
   <prompt-text>\n
   ```
6. Return to the orchestrator: `{session_id, mode: "workbench", terminal_tab_id, status: "started"}`.

The Gateway does **not** watch the TUI for output. For summary feedback, it watches the session JSONL file (`~/.claude/projects/<cwd-hash>/<session-id>.jsonl`) and:

- Detects when a new assistant message has been appended.
- After a configurable idle period (default 30s of no JSONL writes), considers the turn complete.
- Extracts the latest assistant message's text content as the summary.
- Feeds the summary back to the orchestrator on its next turn.

This is best-effort: the user might still be interacting in the terminal when the orchestrator decides the turn is "done." That's fine — the orchestrator's summary is informational, and follow-up turns will re-poll the JSONL.

### When the user takes over a workbench session

The user can interact with the terminal directly at any time. Their messages go into the same session's JSONL because Claude Code is managing the session. The orchestrator's view of the session may lag, but next time the orchestrator polls the JSONL it will see the user's interjections and the assistant's responses. This is acceptable for v1.

---

## Worktree management

### Worktree entity

Stored in Garrison's worktree registry:

```yaml
id: uuid
project: string                # project identifier, matches a project config in Garrison
name: string                   # e.g., "feat/regex-fix"
branch: string                 # git branch name
base_branch: string            # what it was forked from
path: string                   # absolute filesystem path of the git worktree
ports:
  - { name: "frontend", port: 3001 }
  - { name: "backend", port: 3002 }
urls:                          # computed from tailscale hostname + ports
  - { name: "frontend", url: "https://goncalo-mbp.tail-xxx.ts.net:3001" }
  - { name: "backend", url: "https://goncalo-mbp.tail-xxx.ts.net:3002" }
sessions:                      # which Operative sessions are bound to this worktree
  - { soul: "engineer", session_id: "...", tier: {...} }
status: "active" | "merged" | "discarded"
title: string                  # human-readable summary of what this worktree is for
created_at: timestamp
last_active_at: timestamp
```

### Project configuration

Each project Garrison knows about has a config (location TBD by implementer, suggest `~/.garrison/projects/<project-id>.yml`):

```yaml
id: garrison
name: Agent Garrison
root_path: /Users/goncalo/code/garrison
worktree_base: /Users/goncalo/code/garrison-worktrees
port_needs:
  - { name: "frontend", default: 3000 }
  - { name: "backend",  default: 4000 }
startup_commands:              # optional — commands to run after worktree creation
  - "pnpm install"
  - "pnpm dev"                 # would pick up PORT env vars
env_template:                  # how worktree ports map into environment variables
  PORT: "${ports.frontend}"
  BACKEND_PORT: "${ports.backend}"
default_base_branch: main
```

Garrison reads this config when creating a worktree and uses it to:

- Decide how many ports to reserve and what to name them.
- Generate the env vars to pass to startup commands.
- Run startup commands so services come up automatically.

### `garrison-control` MCP additions

```
list_worktrees(project?: string) → [
  { id, project, name, branch, status, title, ports, urls, sessions, last_active_at }, ...
]
```

Returns active worktrees, sorted by last_active_at descending. The orchestrator calls this whenever it suspects a task might relate to existing work, and matches by `title` + `name` semantically (LLM judgment, not a fuzzy match algorithm).

```
create_worktree(
  project: string,
  task_title: string,         // short human-readable summary
  branch_name?: string,       // defaults to a slug of task_title prefixed by feat/ or fix/
  base_branch?: string        // defaults to project's default_base_branch
) → {
  worktree_id, name, path, ports, urls, status
}
```

Creates the git worktree (`git worktree add ...`), reserves ports from the pool, generates env vars, runs startup commands, registers the worktree. Returns immediately with URLs so the orchestrator can surface them right away — but startup commands run async and the URLs may take a moment to actually serve.

```
get_worktree(id: string) → { ...worktree fields... }
```

```
close_worktree(id: string, action: "merge" | "discard" | "leave_open") → { result }
```

- `merge`: opens a PR (`gh pr create` or equivalent), does **not** auto-merge. Returns the PR URL.
- `discard`: removes the git worktree, releases ports, marks status as discarded. Asks for confirmation via... actually, the orchestrator should be confirming with the user before calling this, not Garrison.
- `leave_open`: no-op aside from marking status; useful for "I'm done for now but might come back."

### Orchestrator's worktree workflow

The orchestrator's system prompt gains a worktree section (full update later in this brief). Key behaviors:

1. **Project-related request comes in.** Orchestrator calls `list_worktrees(project="garrison")` (or the project it infers).
2. **Decides: reuse or create.**
   - If the request semantically relates to an existing worktree's title, reuse it: `talk_to(soul="engineer", message=..., worktree_id="...")`.
   - Otherwise: `create_worktree(project, task_title)` then `talk_to(..., worktree_id=...)`.
3. **Asks for user confirmation on close.** When the user signals they're done ("merge it", "looks good", "ship it"), the orchestrator confirms once ("open a PR for the regex-fix worktree?") and on yes calls `close_worktree(id, action="merge")`.
4. **Surfaces URLs.** After creating a worktree, the orchestrator's user-facing message includes the URLs: "→ engineer on feat/regex-fix · frontend: https://...:3001 · backend: https://...:3002".

---

## Port allocation

### Pool

Configured in Garrison's main config:

```yaml
port_pool:
  start: 3000
  end: 3100
```

The pool tracks reserved port ranges. When a worktree is created:

1. The project's `port_needs` declares how many ports and what names.
2. The allocator finds the next available contiguous range of N ports.
3. Reserves them, associates with the worktree ID.
4. Returns the assignment.

On `close_worktree`, ports are released back to the pool.

### Tailscale URL resolution

At Gateway startup:

1. Run `tailscale status --json` (or read `tailscale.sock` directly).
2. Extract the local node's MagicDNS hostname (e.g., `goncalo-mbp.tail-xxx.ts.net`).
3. Cache it. If Tailscale is not running, fall back to `localhost` for URLs.

URLs are computed as `https://<tailscale-host>:<port>`. Note that the project's services need to bind to `0.0.0.0`, not `127.0.0.1`, for the Tailscale interface to serve them. The project config or its startup commands are responsible for that; Garrison does not enforce it.

If Tailscale is unavailable, URLs use `http://localhost:<port>` and the orchestrator's user-facing message notes "Tailscale not detected; URLs work locally only."

---

## Tier-aware session lifecycle

### Tier shape

Whatever the existing tier classifier returns — for this brief, assume:

```yaml
tier:
  model: "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5"
  effort: "low" | "medium" | "high"
  needs_testing: bool
  needs_agents_team: bool
  # ... other fields existing classifier already returns
```

The classifier is invoked via `classify_tier(task_description, project_hints?) → tier`. The orchestrator calls this before any `talk_to` for project work.

### Session tier tracking

Each session's record gains a `tier` field, set at spawn time. It also gains a `tier_flags` field — the actual CLI flags applied (`--model claude-opus-4-7`, etc.), so the Gateway knows exactly how to respawn.

### Respawn flow

When the orchestrator calls `talk_to(soul, message, worktree_id, ...)`:

1. Gateway finds the existing session for that worktree + Soul, if any.
2. Gateway calls `classify_tier(message)` (or accepts a tier hint on the `talk_to` call).
3. If no existing session: spawn fresh with the classified tier.
4. If existing session and tier matches: just send the message (resume).
5. If existing session and tier **differs**: kill the existing process, then respawn with `--resume <session-id> --model <new-model> [other new flags]`. The session ID is the same; the model and effort are different; the prior conversation context loads from JSONL on resume.

Step 5 needs verification in Phase 1: confirm Claude Code allows changing `--model` on `--resume`. If it doesn't, the fallback is `--continue` semantics (resume the most recent session in cwd with new flags). Either way the user-facing experience is the same: their context persists, the tier changes.

### Workbench mode and respawn

In workbench mode, killing and respawning means:

1. Kill the Claude Code process inside the terminal tab (send `^C` via PTY, or `kill` the PID).
2. In the same tab, run the new `claude` command.
3. Type the new prompt.

The terminal tab persists across respawns. The user sees: "session ended" then a new `claude` invocation appearing.

---

## Updated `garrison-control` MCP surface

Full list after this brief:

| Tool | Purpose |
|---|---|
| `talk_to` | Send message to a Soul (with worktree_id, mode override) |
| `wait_for` | Block on a session's completion |
| `list_active_sessions` | Enumerate active sub-sessions |
| `end_session` | Manually close a session |
| `classify_tier` | Get tier classification for a task description |
| `list_worktrees` | Enumerate worktrees (optionally filtered by project) |
| `create_worktree` | Create a new worktree with allocated ports |
| `get_worktree` | Get details of a specific worktree |
| `close_worktree` | Merge (PR), discard, or leave-open a worktree |

`talk_to` signature gains:

```
talk_to(
  soul: string,
  message: string,
  worktree_id?: string,        // bind session to this worktree
  mode?: "headless" | "workbench",
  tier_hint?: tier,            // override classifier
  task_title?: string,
  channel?: string
) → {
  session_id, status, channel, mode, worktree_id?, urls?
}
```

When `worktree_id` is provided, `talk_to`'s response includes the worktree's URLs so the orchestrator can mention them.

---

## Orchestrator system prompt — additions

Add a new section to the Orchestrator Soul's `system-prompt.md`:

```markdown
## Project work, worktrees, and ports

Project-related requests (coding, design, architecture work on Gonçalo's projects) run in **worktrees**. Each worktree is a git worktree on a feature branch with its own port allocation and Tailscale URLs.

### Routing project work

When a request involves project work:

1. Call `list_worktrees(project=<project>)` to see what's already in flight.
2. Decide whether the request continues an existing worktree or needs a new one. Match by the worktree's `title` and `name` — if the task semantically relates, reuse it. If you're unsure, ask Gonçalo: "is this for the existing feat/regex-fix worktree or a new one?"
3. If new: `create_worktree(project, task_title)` then delegate via `talk_to(..., worktree_id=...)`.
4. If reusing: delegate via `talk_to(..., worktree_id=<existing>)`.

When you create or reuse a worktree, surface its URLs in your user-facing message: "→ engineer on feat/regex-fix · frontend: https://...:3001". Gonçalo will click them on mobile.

### Tier classification

Before delegating project work, call `classify_tier(message)` to get the right model/effort for the task. Pass the result as `tier_hint` to `talk_to`. The classifier is fast — don't skip it.

If the worktree already has an active session with a different tier than what the classifier returned, the Gateway will transparently kill and respawn with the new tier. You don't need to manage this; just always pass the freshly classified tier.

### Closing worktrees

When Gonçalo signals work is done ("merge it", "ship it", "looks good"), confirm once and call `close_worktree(id, action="merge")`. This opens a PR — it does not auto-merge. Report the PR URL.

If he says "drop it" or "scrap it", confirm once and use `action="discard"`.

If he says nothing about closing, leave the worktree open. They persist across conversations.

### Surface awareness

Each turn you receive carries an `[origin: workbench]` or `[origin: channel]` prefix. You don't usually need to think about it — `talk_to` defaults to the right spawn mode for the origin. Override only if Gonçalo asks for something specific ("run it in the background" → `mode: "headless"` even on workbench).

Non-project work (assistant, researcher, companion conversations) does not use worktrees. Skip the worktree dance for those.
```

---

## Implementation phases

### Phase 1 — Verification spikes

Before building anything, run these spikes to nail down unknowns:

- Confirm `claude --resume <id> --model <different-model>` works and preserves context. If not, document the actual mechanism for changing tier mid-session.
- Confirm `tailscale status --json` works on the target machine and yields the expected MagicDNS hostname. Document the parse.
- Confirm `gh pr create` is available and configured for the projects Gonçalo wants to use.

**Verify:** Each spike produces a one-paragraph confirmation or correction note in the brief's "Notes for implementer" section.

### Phase 2 — Worktree registry and port allocator

Implement the worktree registry (in-memory + persisted to disk), port allocator with pool, project config loader. No orchestrator integration yet — just the services.

**Verify:** Via a debug CLI or tests:
- Create a worktree, observe git worktree on disk, ports reserved, URLs computed.
- Close worktree as `discard`, observe git worktree removed, ports released.
- Close worktree as `merge`, observe PR opened (point at a throwaway test branch).

### Phase 3 — `garrison-control` MCP extensions

Add the new MCP tools: `classify_tier`, `list_worktrees`, `create_worktree`, `get_worktree`, `close_worktree`. Wire `classify_tier` to the existing classifier.

**Verify:** Invoke each tool from a test MCP client, confirm correct shape and behavior.

### Phase 4 — Surface-aware spawn in the Gateway

Add origin tagging on incoming requests, propagate to orchestrator turns, extend `talk_to` to accept `worktree_id`, `mode`, `tier_hint`. Implement workbench-mode spawn (terminal tab open + PTY input + JSONL polling).

**Verify:**
- Channel-origin `/chat` request → orchestrator turn includes `[origin: channel]` prefix; `talk_to` spawns headless.
- Workbench-origin `/chat` request → orchestrator turn includes `[origin: workbench]` prefix; `talk_to` opens a new terminal tab in the workbench, types the prompt, user can interact.
- Switching origin mid-conversation works: ask something on mobile, then ask a follow-up on desktop; orchestrator handles both.

### Phase 5 — Tier-aware respawn

Wire the kill-and-respawn flow when an existing session's tier doesn't match the new request's classified tier.

**Verify:**
- Start a worktree with a low-effort Haiku tier. Send a follow-up that classifies as high-effort Opus. Observe the Gateway killing the existing Claude Code process and respawning with the new model flag, prior context preserved (test by asking "what did we just discuss?").
- Same test in workbench mode: terminal tab kills its Claude Code, restarts with new flags, types follow-up prompt.

### Phase 6 — Orchestrator prompt update and end-to-end

Update the Orchestrator Soul's `system-prompt.md` with the worktree/tier/origin sections from this brief. Run end-to-end flows:

- Mobile: "fix the regex bug in LoginForm" → worktree created, URLs surfaced, engineer runs headless, completes, summary back, user says "ship it", PR opened.
- Desktop: "let's work on the notification system design" → architect, worktree created (or not, if it's a design conversation without code work — orchestrator judgment), workbench terminal opens, user collaborates interactively.
- Cross-surface: start a task on mobile, follow up on desktop, observe continuity.

**Verify:** Two days of dogfooding (the same day-two validation cycle as the prior brief). Goal: can Gonçalo work this way comfortably for typical project tasks?

---

## Locked decisions

1. **One orchestrator per user, origin-tagged turns.** Not per-channel.
2. **Workbench mode reads summaries from JSONL on disk.** Not from PTY output.
3. **The Gateway is responsible for tier respawn.** The orchestrator just passes `tier_hint`; it doesn't kill or spawn directly.
4. **PR on merge, not auto-merge.** v1.
5. **The existing tier classifier is the source of truth for tier decisions.** Not the orchestrator's judgment.
6. **Tailscale URLs preferred; localhost fallback when Tailscale absent.**
7. **Services in worktree projects bind to `0.0.0.0` — Garrison does not enforce this.** Project config / startup commands handle it.

---

## Out of scope

- Auto-cleanup of stale worktrees (worktrees persist until explicitly closed).
- Multi-user / shared worktree sessions.
- Conflict detection when two worktrees touch the same files.
- Web UI for editing project configs (edit YAML directly for v1).
- Reservation of non-contiguous port ranges.
- Workbench-mode summary polling tuned for active user interaction (the 30s idle heuristic is crude — refinement is v1.1).
- Tier downgrade on idle (e.g., automatically dropping a session from Opus to Sonnet when it's been idle).
- PR auto-update when the user makes more changes after merge action (the PR is opened at one snapshot; subsequent commits land on the branch but the orchestrator doesn't track them).

---

## Notes for the implementer

- The "JSONL polling for workbench summary" approach is the most fragile piece of this brief. If it's annoying in practice, the alternative is a small `garrison-control` MCP tool the user (or Claude Code itself, via skill) calls inside the terminal session to push a summary explicitly: `report_summary(text)`. Cleaner but requires the user or the Soul to remember to call it. Keep JSONL polling for v1; consider explicit reporting in v1.1.

- The orchestrator's worktree matching is LLM judgment, not fuzzy string match. The system prompt instructs it to compare semantically. If this misroutes often in practice, the fix is a tighter prompt or an explicit clarifying question — not adding a deterministic matcher.

- For the PR creation step, `gh pr create --fill --web=false --base <base_branch>` is a reasonable default. The orchestrator can pass a custom title/body via `close_worktree`'s parameters (extend the signature if needed).

- The port pool starts at 3000 because that's a common dev port; if Gonçalo runs other things on 3000–3100 outside Garrison, conflicts will happen. Either move the pool (`port_pool.start: 5000`) or have the allocator probe for actual availability before reserving. Latter is more robust; do it if implementation cost is low.

- The Sequoias/Ekoa Dev port handling pattern Gonçalo referenced is a useful reference for the env-template substitution mechanism — implementer should look there before designing from scratch.

- When the orchestrator surfaces URLs, format them as plain links in the message (the UI will linkify). Don't construct fancy markdown link syntax; plain `https://...` is fine and works in both desktop and mobile renderers.
