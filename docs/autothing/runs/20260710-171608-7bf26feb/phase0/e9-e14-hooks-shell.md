Findings delivered to team-lead. Summary of both exploration items:

## E9 — Hook wiring

**Settings layering:** Garrison injects **no** settings/hook config into the sessions it spawns. `buildClaudeArgs` (`packages/claude-pty/src/session.mjs:56`) deliberately omits `--setting-sources`, so operatives inherit the full default cascade (user `~/.claude/settings.json` + project `.claude/settings.json` + local). The only injected flags are `--append-system-prompt-file`, `--session-id`/`--continue`/`--resume`, and `--model`. Every operative therefore runs the user's hook block verbatim.

**Hook ownership (from `~/.claude/settings.json`):** Stop has 4 owners — autothing `goal-stop.sh`, harmonika `sync-memory.sh`, herdr `herdr-agent-state.sh idle`, then Garrison observability curl-POSTs to :7081/:7086. PostToolUse is **entirely** Garrison observability POSTs with `matcher: ""` (no per-tool matching in use). basic-memory runs only on PreCompact/SessionEnd.

**Ordering / new Improver Stop hook:** Claude Code runs **all** matching Stop hooks (not first-wins) and blocks if **any** returns `{"decision":"block","reason":...}`, stacking reasons. So an Improver Stop hook coexists with the goal loop rather than displacing it. To stay silent under an engine-dispatched worker, it reads the Stop payload's `.session_id` and tests `[ -f ~/.autothing/sentinels/<session_id>.json ]` — present means the goal loop owns the session, so exit 0 (this mirrors `goal-stop.sh`'s own gate at line 31).

**The two capability answers:** Yes — a Stop hook blocks once + injects instructions via `{"decision":"block","reason":...}` (goal-stop.sh:72), though "once" requires self-gating on a sentinel. Yes — PostToolUse supports a tool-name `matcher` (e.g. `"AskUserQuestion"`); it's available and currently unused.

## E14 — PTY stream parsing

**Two parse layers** in `packages/claude-pty/src/`, both consumed by `fittings/seed/http-gateway/scripts/gateway-pty.mjs` (the :4777 SSE surface): (a) **screen-scraping** — `screen.mjs` over @xterm/headless, polled by `rich-stream.mjs openRichStream`; (b) **JSONL** — `jsonl.mjs parseTurn/parseEvents`.

**The live chat path is screen-scraping only** and carries ANSI-stripped text — no structured tool blocks. Structured tool payloads (including an AskUserQuestion tool_use with its full `input`/options arrays) exist **only** in `jsonl.mjs parseEvents` (lines 140-146), but its sole consumer is `tests/claude-pty.test.ts` — it is not wired into any gateway or web-channel path. The `ChatEvent` union (`transport.ts:15-22`) has no `tool` variant, so AskUserQuestion reaches the phone today only as scraped menu text inside the markdown blob.

**Where tappable option buttons plug in:**
- Server: `gateway-pty.mjs` `/chat/stream` handler (551-595) / `runTurn` (394) — parse the session JSONL via `jsonl.mjs`, emit a new `tool` SSE event, forward through the web-channel proxy, and add a `tool` variant to `ChatEvent` (`packages/claude-chat/src/transport.ts:15`).
- Client: `packages/claude-chat/src/ClaudeChat.tsx`, inside the `turns.map` render at `<div className="cc-assistant">` (line 915, beside the `cc-md` div at 916) — render buttons, wire clicks to the transport, and carry `question`/`options` on the Turn model.
