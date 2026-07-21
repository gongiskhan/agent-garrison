# Claude Code Runtime

The **Claude Code runtime** is the node-pty + `@xterm/headless` engine
(`packages/claude-pty`) that drives the real interactive Claude Code TUI. It is
the **default primary runtime** in Agent Garrison — the engine that hosts the
Operative's orchestrator loop, via the HTTP gateway or the direct PTY operative.

It is a first-class, selectable peer of the other Runtime-Faculty fittings
(`agent-sdk-runtime`, `codex-runtime`, `gemini-runtime`):

- **Provides** the `runtime` capability named `claude-code`.
- Is the default value for a composition's **primary runtime** (the runtime that
  runs the orchestrator). See `GlobalConfig.primary_runtime`.
- Registers as a **orchestrator `runtime: claude-code` target**, so the
  orchestrator can route individual turns to it at a chosen model + effort.

## Provider overrides

Pick a `provider` to run the **same** Claude Code engine against a different
inference backend. Provider/base-url/vault-key resolution reuses the
orchestrator `PROVIDERS` registry (`fittings/seed/orchestrator/lib/stage-b.mjs`):

| provider        | base URL                          | auth |
|-----------------|-----------------------------------|------|
| `anthropic-plan` (default) | none (Max OAuth)        | your Max account |
| `ollama-local`  | `http://localhost:11434`          | none (dummy token) |
| `deepseek`      | `https://api.deepseek.com/anthropic` | vault `DEEPSEEK_API_KEY` |
| `zai-glm`       | `https://api.z.ai/api/anthropic`  | vault `ZAI_API_KEY` |

Non-default providers swap `ANTHROPIC_BASE_URL` and pull the auth token from the
vault. `base_url` is an advanced explicit override.

## Config

| key        | type   | default          | meaning |
|------------|--------|------------------|---------|
| `provider` | select | `anthropic-plan` | inference backend |
| `model`    | select | `opus`           | default model (`GARRISON_MODEL`) |
| `base_url` | string | `""`             | advanced explicit `ANTHROPIC_BASE_URL` override |

## Verify

```
node scripts/probe.mjs --probe   # prints "ok" when the `claude` CLI is reachable
```

The probe is read-only: it confirms the `claude` CLI is on PATH (the runtime's
one hard prerequisite) without spawning the TUI.
