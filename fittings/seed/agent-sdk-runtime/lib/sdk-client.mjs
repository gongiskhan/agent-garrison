// sdk-client.mjs — the SOLE module that imports the Claude Agent SDK.
//
// Isolated on purpose so the adapter stays injectable/testable: the adapter
// lazy-imports this module only inside its default client factory, so the unit
// path (which injects `createClient`) never loads the SDK. The Agent SDK is a
// first-class runtime (D29), routable to the Anthropic endpoint as well as
// third-party ones.
//
// Pinned: @anthropic-ai/claude-agent-sdk is pinned in this fitting's package.json
// (the bundled CLI is pinned transitively via the SDK's locked dependency).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createMcpReadyQuery } from "./mcp-readiness.mjs";
import { spawnGuardedClaudeProcess } from "./guarded-spawn.mjs";

// Thin wrapper so the adapter stays injectable/testable: returns the SDK's Query
// (an AsyncGenerator of SDKMessage). The adapter consumes it directly — structured
// request/response, no terminal scraping.
//
// Every query spawns through spawnGuardedClaudeProcess: the SDK's default spawn
// leaves the child's stdin without an 'error' listener, and one EPIPE there
// crashes the process hosting the session (see ./guarded-spawn.mjs). A caller
// that brings its own spawnClaudeCodeProcess keeps it.
export function createSdkClient({ prompt, options }) {
  const guarded = options?.spawnClaudeCodeProcess
    ? options
    : {
        ...options,
        spawnClaudeCodeProcess: (spawnOptions) =>
          spawnGuardedClaudeProcess(spawnOptions, {
            stderr: options?.stderr,
            onStdinError: (error) => {
              console.error(`[agent-sdk] claude stdin closed under a pending write (${error?.code ?? error?.message ?? error}); the turn fails, the host stays up`);
            },
          }),
      };
  return createMcpReadyQuery(query, { prompt, options: guarded });
}
