// sdk-client.mjs — the SOLE module that imports the Claude Agent SDK.
//
// Isolated on purpose: the programmatic-purge guard scopes its `@anthropic-ai/`
// exception to exactly this one fenced file (see tests/programmatic-purge.test.ts
// — the exception requires lib/fence.mjs to exist alongside it). THE FENCE
// (lib/fence.mjs, enforced in agent-sdk-adapter.mjs#spawn) MUST pass before this
// module's createSdkClient is ever reached: the adapter lazy-imports this module
// only inside its default client factory, after assertFence() has run.
//
// Pinned: @anthropic-ai/claude-agent-sdk is pinned in this fitting's package.json
// (the bundled CLI is pinned transitively via the SDK's locked dependency).
import { query } from "@anthropic-ai/claude-agent-sdk";

// Thin wrapper so the adapter stays injectable/testable: returns the SDK's Query
// (an AsyncGenerator of SDKMessage). The adapter consumes it directly — structured
// request/response, no terminal scraping.
export function createSdkClient({ prompt, options }) {
  return query({ prompt, options });
}
