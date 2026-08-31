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

// ── 3. the static prefix ────────────────────────────────────────────────────
//
// The cache prefix hashes tools -> system -> messages, so ANY byte that varies
// between two stretches forks it. Captured live (bench/static-prefix-2026-08-31)
// across two ~/dev projects and two commits in one repo, the SDK's single big
// system block carries four kinds of per-project / per-commit material, all of
// it INSIDE the cached region:
//
//   1. the per-project memory directory (~/.../projects/<cwd-slug>/memory/)
//   2. the `# Environment` block: primary working directory, is-a-git-repo
//   3. preset paragraphs that vary by project for reasons outside Garrison
//      (one 160-char paragraph was present for four cwds and absent for a
//      fifth) - which is why this cuts by REGION rather than by known line
//   4. the trailing git snapshot: current branch, git status, recent commits.
//      This is the expensive one. It changes on every commit, so the prefix
//      forks WITHIN a task, not merely between projects.
//
// Everything from `# Environment` up to the appended composition prompt moves,
// which sweeps up (2) and (3) together; the memory line and the git snapshot
// are cut on their own. The composition's assembled prompt is byte-stable and
// stays cached, and it now sits BEFORE the moved material: static preset and
// static composition prompt first, per-project and per-day last.
//
// Nothing is dropped. The moved text is re-emitted as a system block with no
// cache_control, so the model sees the same bytes, later.

/** The per-project memory directory line the CLI injects. */
const MEMORY_LINE = /\nYou have a persistent[^\n]*memory[^\n]*\n/;
/** The CLI's environment block; it runs to the composition prompt appended after it. */
const ENVIRONMENT_HEADING = "\n# Environment\n";
/** Where the appended composition prompt starts. */
const COMPOSITION_PROMPT = "<!-- GARRISON-SECTION";
/** The git snapshot the CLI appends after everything else. */
const GIT_SNAPSHOT = "\ngitStatus: This is the git status";

/**
 * Split one system block into the part that is identical for every project and
 * every commit, and the part that is not. Pure, and lossless: the two pieces
 * carry exactly the characters of the input between them.
 *
 * A marker that is not found simply means that cut is not made, so an upstream
 * prompt change degrades to "moved less" rather than to a corrupted prompt.
 */
export function splitStaticPrefix(text) {
  if (typeof text !== "string" || !text) return { static: text ?? "", dynamic: "", moved: [] };
  const staticParts = [];
  const dynamicParts = [];
  const moved = [];
  let cursor = 0;

  const memory = MEMORY_LINE.exec(text);
  if (memory) {
    // Keep the newline that opened the match with the static side, so the
    // paragraph break survives; the line itself goes to the tail.
    staticParts.push(text.slice(cursor, memory.index + 1));
    dynamicParts.push(text.slice(memory.index + 1, memory.index + memory[0].length));
    cursor = memory.index + memory[0].length;
    moved.push("memory-directory");
  }

  const env = text.indexOf(ENVIRONMENT_HEADING, cursor);
  const composition = env >= 0 ? text.indexOf(COMPOSITION_PROMPT, env) : -1;
  if (env >= 0 && composition > env) {
    staticParts.push(text.slice(cursor, env));
    dynamicParts.push(text.slice(env, composition));
    cursor = composition;
    moved.push("environment");
  }

  const git = text.indexOf(GIT_SNAPSHOT, cursor);
  if (git >= 0) {
    staticParts.push(text.slice(cursor, git));
    dynamicParts.push(text.slice(git));
    cursor = text.length;
    moved.push("git-snapshot");
  } else {
    staticParts.push(text.slice(cursor));
    cursor = text.length;
  }

  return { static: staticParts.join(""), dynamic: dynamicParts.join(""), moved };
}

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
 *   staticPrefix  boolean              move every per-project and per-commit
 *                                      span out of the cached system block into
 *                                      an uncached one after it.
 * @returns {{ body: object, changes: object }}
 */
export function shapeAnthropicRequest(body, opts = {}) {
  const changes = { cacheTtl: null, toolSearch: null, staticPrefix: null };
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

  // ── 3. move the variable spans out of the cached system block ───────────
  if (opts.staticPrefix && Array.isArray(out.system) && out.system.length) {
    // The block that holds the prompt is the LAST one carrying a breakpoint:
    // everything before its cache_control is what a later stretch can read.
    let last = -1;
    for (let i = 0; i < out.system.length; i += 1) {
      const cc = out.system[i]?.cache_control;
      if (isPlainObject(cc) && cc.type === "ephemeral") last = i;
    }
    const block = last >= 0 ? out.system[last] : null;
    if (block && typeof block.text === "string") {
      const split = splitStaticPrefix(block.text);
      if (split.dynamic) {
        const system = out.system.slice();
        system[last] = { ...block, text: split.static };
        // No cache_control: this block is deliberately outside every entry.
        const { cache_control, ...shape } = block;
        system.push({ ...shape, text: split.dynamic });
        clone().system = system;
        changes.staticPrefix = {
          moved: split.moved,
          movedChars: split.dynamic.length,
          staticChars: split.static.length,
        };
      }
    }
  }

  return { body: out, changes };
}

/**
 * The bytes the API will hash to decide whether this request can read another
 * request's cache: the tool block, then every system block up to and including
 * the last breakpoint.
 *
 * ONE exclusion, and it is measured rather than assumed. The first system block
 * is `x-anthropic-billing-header: ... cch=<nonce>`, and the nonce changes on
 * every single request; a controlled two-request probe
 * (bench/prefix-2026-08-29/cache-share-probe.mjs) showed two requests sharing a
 * prefix with it varying, so it is not part of the cache key. Including it here
 * would make the digest differ for every request and prove nothing.
 */
export function cacheablePrefixParts(body) {
  const system = Array.isArray(body?.system) ? body.system : [];
  let last = -1;
  for (let i = 0; i < system.length; i += 1) {
    const cc = system[i]?.cache_control;
    if (isPlainObject(cc) && cc.type === "ephemeral") last = i;
  }
  const blocks = (last >= 0 ? system.slice(0, last + 1) : [])
    .filter((b) => !(typeof b?.text === "string" && b.text.startsWith("x-anthropic-billing-header:")))
    .map((b) => b?.text ?? "");
  return { tools: Array.isArray(body?.tools) ? body.tools : [], system: blocks };
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
