# coord-agentmail

mcp_agent_mail coordination Fitting for Agent Garrison — runs the FastMCP
agent-mail server as an **arm's-length external process** (own-port pattern),
giving parallel Claude Code sessions identities, messaging, and **advisory file
leases** (claim paths with a TTL + heartbeat + intent `reason`).

- **Upstream:** github.com/Dicklesworthstone/mcp_agent_mail @
  `de9e6288367e20a8b81e203960da9219ab8aa48f`.
- **License:** **MIT + OpenAI/Anthropic rider** (verified at the pin). The rider
  grants no rights to "Restricted Parties" (incl. Anthropic/OpenAI); "use"
  includes analyzing/incorporating.

## License isolation (hard constraint)

agent_mail is **cloned to `~/.garrison/external/mcp_agent_mail`** (OUTSIDE
Garrison's MIT tree) and invoked **only** as a separate process
(`uv run python -m mcp_agent_mail.http`). It is **never imported or vendored**
into Garrison's source, **never wired to Ekoa**, and its source is kept out of
the cross-model (Codex/OpenAI) review scope. `setup.sh` and `verify.sh` both
assert the clone is outside the repo. Risk accepted by the operator.

## Runtime

- **Faculty:** `memory` (own-port, default port 28765). Provides `memory-store: agent-mail`.
- **Server:** `uv run python -m mcp_agent_mail.http --host 127.0.0.1 --port 28765`
  (supervised by `scripts/start.mjs`, Garrison's own-port entry).
- **Status file:** `~/.garrison/ui-fittings/coord-agentmail.json`
  (`{port, url, mcpUrl, webUrl, pid, startedAt}`).
- **MCP endpoint:** `http://127.0.0.1:28765/mcp` (streamable-http). Registered as an
  http MCP server `coord-agentmail` in `~/.claude.json` (user scope) on start, so a
  direct `claude` run in any repo and the orchestrator both reach it.
- **Web UI:** `http://127.0.0.1:28765/mail`.

## Repo-scoping

One shared server across all projects; sessions are tagged by `cwd`/repo, so
leases/messages a session sees are repo-scoped — never cross-project.

## Lifecycle / reboot semantics (Garrison-supervised)

agent_mail is supervised by Garrison using the existing own-port + eager-boot
machinery — no bespoke daemon:

- **Auto-start on activation.** Selecting the fitting marks it **eager**
  (`setEagerBoot("coord-agentmail", true)`, wired in `runner.up()`), so it boots
  with Garrison via `runEagerBoot` and is **standing** by default for the
  coordination use case.
- **Survives operative `down` + Garrison restart.** Eager (server-lifecycle)
  fittings are exempt from the `down` stop and the startup orphan sweep, so
  agent_mail stays up across operative restarts. **"Survives reboot" means it comes
  back when Garrison next starts** — the normal path. (A standalone launchd
  LaunchAgent for OS-reboot survival independent of Garrison is intentionally out
  of scope.)
- **Restart on crash.** Re-spawned by `runEagerBoot` on the next Garrison/operative
  start (a dead status-file pid is detected and replaced), and on demand via
  `POST /api/fittings/coord-agentmail/restart` (and the **Restart agent_mail**
  button in the Coordination view).
- **Clean stop on deactivation.** Deselecting un-eagers it and stops the server
  (`setEagerBoot(false)` + `stopOwnPortFitting("coord-agentmail")` in `runner.up`'s
  coord reconcile), and `reconcileCoordTeardown` removes its MCP registration.

A pre-registration snapshot of `~/.claude.json` is written to
`~/.garrison/snapshots/claude-json.before-coord-agentmail.json` (durable, not `/tmp`).

## Scripts

- `scripts/setup.sh` — clone+pin agent_mail to `~/.garrison/external`, `uv sync` (isolation-guarded).
- `scripts/start.mjs` — own-port entry: supervise server, write status file, register MCP.
- `scripts/register-mcp.mjs` — `add [port]` / `remove` the http MCP entry in `~/.claude.json` (guarded).
- `scripts/verify.sh` — read-only: uv + clone + module runnable + isolation → `ok`.
