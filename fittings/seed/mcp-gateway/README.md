# mcp-gateway Fitting

Exposes installed Garrison Faculties as MCP tools to Claude Code sessions
launched in orchestrator-mode compositions.

## What it does

The runner writes an `.mcp.json` file (and a `CLAUDE.md` fragment) into the
project/session working directory that tells Claude Code how to reach this
gateway. Same-machine sessions use the **stdio** transport (Claude Code spawns
the gateway as a child process); remote outpost sessions use the **HTTP**
transport (gateway runs on the Garrison host, Claude Code on the remote machine
connects over Tailscale).

## MCP tools (v1)

| Tool | From | When available |
|---|---|---|
| `classify_tier` | `tier-classifier` Fitting | `tier-classifier` is installed in the composition |
| `run_tests` | `testing` Fitting | `testing` is installed in the composition |

The tool list is computed at startup from what's actually installed. If a
Fitting is removed, its tool disappears from the list without any gateway
restart.

## Usage

Do not invoke the gateway binary directly. The `launch.ts` helper in
src/lib/mcp-gateway/ manages its lifecycle. The only manual use case is:

```bash
# Health check (requires GARRISON_COMPOSITION_DIR to be set)
GARRISON_COMPOSITION_DIR=/path/to/composition \
  node scripts/gateway.mjs --probe

# Manual stdio mode (for debugging with an MCP client)
GARRISON_COMPOSITION_DIR=/path/to/composition \
  node scripts/gateway.mjs stdio

# HTTP mode (port + token required)
GARRISON_COMPOSITION_DIR=/path/to/composition \
  node scripts/gateway.mjs http --port 29876 --token <hex> --host 0.0.0.0
```

## Policy

The `CLAUDE.md` fragment injected by the launcher into the project/session cwd
tells the model when to call these tools. The gateway is the capability; the
policy lives in the prompt.
