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

// Thin wrapper so the adapter stays injectable/testable: returns the SDK's Query
// (an AsyncGenerator of SDKMessage). The adapter consumes it directly — structured
// request/response, no terminal scraping.
export function createSdkClient({ prompt, options }) {
  return query({ prompt, options });
}
