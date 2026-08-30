// anthropic-request-shaper.mjs — the one place Garrison edits an outgoing
// Anthropic request body.
//
// WHY THIS EXISTS. A stretch is a fresh runtime session, so it pays its whole
// boot prefix on its first API call. Measured 2026-08-29: 43,248 tokens on a
// sonnet `implement` stretch, six or seven times per conversation. Two levers
// halve that bill and neither is reachable through the Agent SDK's options:
//
//   1. CACHE TTL. The API caches a prefix for 5 minutes by default. Garrison's
//      stretches are minutes apart and each one is long, so every stretch
//      re-WRITES the same prefix instead of reading it. Measured on the same
//      day, same account: `claude -p` wrote 1-hour caches (125,190 tokens of
//      ephemeral_1h) while Agent SDK stretches wrote 5-minute ones (241,854 of
//      ephemeral_5m, 0 of 1h). A 1h write costs 2x base input against 1.25x,
//      and every later read is 0.1x - so it pays for itself the first time a
//      second stretch reuses it, and a conversation has six.
//
//   2. TOOL SEARCH / defer_loading. Not in the SDK's `tools` option at all
//      (`string[] | {type:'preset'}`), and `ENABLE_TOOL_SEARCH` is a
//      server-side gate. Measured directly against /v1/messages: ten tools
//      inlined 7,414 tokens, the same ten deferred behind
//      `tool_search_tool_regex_20251119` cost 717 - a 90.3% cut.
//
// The shaper is a PURE function so both are testable without a network, and
// every rewrite it makes is reported rather than silent - a body Garrison
// edited on the way out must be visible in the log next to the one it sent.
//
// Ordering matters and is not negotiable: the cache prefix hashes
// tools -> system -> messages. Anything that varies per duty must sit AFTER
// the last cache breakpoint or it forks the prefix and no stretch ever reads
// another's cache.

/** Tool-search variants the API accepts. regex = Claude writes Python
 *  re.search patterns; bm25 = natural language. */
export const TOOL_SEARCH_VARIANTS = {
  regex: { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
  bm25: { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {object} body        the parsed /v1/messages request
 * @param {object} opts
 *   cacheTtl      "1h" | "5m" | null   rewrite cache_control on the SYSTEM
 *                                      breakpoints only. Message breakpoints
 *                                      are per-conversation and are never
 *                                      reused by another stretch, so paying
 *                                      2x for them would be pure loss.
 *   toolSearch    null | { variant, keepLoaded: string[] }
 *                                      defer every tool except `keepLoaded`
 *                                      and the injected search tool.
 * @returns {{ body: object, changes: object }}
 */
export function shapeAnthropicRequest(body, opts = {}) {
  const changes = { cacheTtl: null, toolSearch: null };
  if (!isPlainObject(body)) return { body, changes };

  let out = body;
  const clone = () => { if (out === body) out = { ...body }; return out; };

  // ── 1. cache TTL on the system breakpoints ──────────────────────────────
  const ttl = opts.cacheTtl === "1h" || opts.cacheTtl === "5m" ? opts.cacheTtl : null;
  if (ttl && Array.isArray(body.system)) {
    let touched = 0;
    const system = body.system.map((block) => {
      const cc = block?.cache_control;
      if (!isPlainObject(cc) || cc.type !== "ephemeral") return block;
      if (cc.ttl === ttl) return block;
      touched += 1;
      return { ...block, cache_control: { ...cc, ttl } };
    });
    if (touched) {
      clone().system = system;
      changes.cacheTtl = { ttl, blocks: touched };
    }
  }

  // ── 2. deferred tool loading ────────────────────────────────────────────
  const ts = opts.toolSearch;
  if (ts && Array.isArray(body.tools) && body.tools.length) {
    const variant = TOOL_SEARCH_VARIANTS[ts.variant] ?? TOOL_SEARCH_VARIANTS.regex;
    const already = body.tools.some((t) => typeof t?.type === "string" && t.type.startsWith("tool_search_tool_"));
    if (!already) {
      const keep = new Set(Array.isArray(ts.keepLoaded) ? ts.keepLoaded : []);
      let deferred = 0;
      const tools = body.tools.map((t) => {
        if (!isPlainObject(t)) return t;
        // A server tool is never deferrable, and a tool carrying a cache
        // breakpoint cannot be deferred (the API returns 400) - leave both.
        if (typeof t.type === "string" && t.type !== "custom") return t;
        if (t.cache_control) return t;
        if (keep.has(t.name)) return t;
        deferred += 1;
        return { ...t, defer_loading: true };
      });
      // "At least one tool must have defer_loading=false" - the search tool is
      // that tool, and it goes FIRST so the tools block stays byte-stable
      // whatever the catalogue behind it looks like.
      if (deferred > 0) {
        clone().tools = [variant, ...tools];
        changes.toolSearch = { variant: variant.type, deferred, kept: [...keep] };
      }
    }
  }

  return { body: out, changes };
}

/** Did the response come back carrying tool-search blocks? The SDK has to pass
 *  `server_tool_use` and `tool_search_tool_result` back unchanged on the next
 *  request or the conversation breaks - this is what the spike measures. */
export function describeToolSearchBlocks(body) {
  const content = Array.isArray(body?.content) ? body.content : [];
  return {
    serverToolUse: content.filter((b) => b?.type === "server_tool_use").map((b) => b.name),
    searchResults: content
      .filter((b) => b?.type === "tool_search_tool_result")
      .map((b) => (b?.content?.tool_references ?? []).map((r) => r.tool_name)),
  };
}
