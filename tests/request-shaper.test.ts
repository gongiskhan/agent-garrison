// The proxy is the only seam where Garrison can set request fields the Agent
// SDK does not expose. Both of them are load-bearing for the boot prefix, and
// both are easy to get subtly wrong in ways that cost money silently.
import { describe, it, expect } from "vitest";
// @ts-ignore - pure .mjs module (single-line: TS7016 lands on the closing line of a multi-line import)
import { shapeAnthropicRequest, describeToolSearchBlocks, TOOL_SEARCH_VARIANTS } from "../fittings/seed/http-gateway/scripts/lib/anthropic-request-shaper.mjs";

const req = (over: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5",
  system: [
    { type: "text", text: "billing header" },
    { type: "text", text: "preset", cache_control: { type: "ephemeral" } },
    { type: "text", text: "assembled", cache_control: { type: "ephemeral" } },
  ],
  tools: [
    { name: "Bash", description: "run a command", input_schema: { type: "object" } },
    { name: "Workflow", description: "orchestrate", input_schema: { type: "object" } },
    { name: "mcp__garrison__run_card", description: "run a card", input_schema: { type: "object" } },
  ],
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  ...over,
});

describe("cache TTL rewriting", () => {
  it("raises the system breakpoints to 1h", () => {
    const { body, changes } = shapeAnthropicRequest(req(), { cacheTtl: "1h" });
    expect(changes.cacheTtl).toEqual({ ttl: "1h", blocks: 2 });
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.system[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("leaves the un-cached block alone", () => {
    const { body } = shapeAnthropicRequest(req(), { cacheTtl: "1h" });
    expect(body.system[0].cache_control).toBeUndefined();
  });

  // A message breakpoint belongs to ONE conversation and is never read by
  // another stretch, so a 1h write there is 2x base input for nothing.
  it("never touches message breakpoints", () => {
    const { body } = shapeAnthropicRequest(req(), { cacheTtl: "1h" });
    expect((body.messages[0].content as any)[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op when the TTL already matches, so an unchanged body is forwarded verbatim", () => {
    const already = req({
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
    const { body, changes } = shapeAnthropicRequest(already, { cacheTtl: "1h" });
    expect(changes.cacheTtl).toBeNull();
    expect(body).toBe(already);
  });

  it("ignores a TTL it does not recognise rather than sending it upstream", () => {
    const { changes } = shapeAnthropicRequest(req(), { cacheTtl: "7d" });
    expect(changes.cacheTtl).toBeNull();
  });

  it("does not mutate the caller's body", () => {
    const original = req();
    shapeAnthropicRequest(original, { cacheTtl: "1h" });
    expect(original.system[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("deferred tool loading", () => {
  it("injects the search tool first and defers the rest", () => {
    const { body, changes } = shapeAnthropicRequest(req(), { toolSearch: { variant: "regex", keepLoaded: ["Bash"] } });
    expect(body.tools[0]).toEqual(TOOL_SEARCH_VARIANTS.regex);
    expect(body.tools.find((t: any) => t.name === "Bash").defer_loading).toBeUndefined();
    expect(body.tools.find((t: any) => t.name === "Workflow").defer_loading).toBe(true);
    expect(body.tools.find((t: any) => t.name === "mcp__garrison__run_card").defer_loading).toBe(true);
    expect(changes.toolSearch).toMatchObject({ deferred: 2, kept: ["Bash"] });
  });

  it("takes the bm25 variant when asked", () => {
    const { body } = shapeAnthropicRequest(req(), { toolSearch: { variant: "bm25", keepLoaded: [] } });
    expect(body.tools[0]).toEqual(TOOL_SEARCH_VARIANTS.bm25);
  });

  // "At least one tool must have defer_loading=false" - a 400 otherwise. The
  // search tool is that tool and must never itself be deferred.
  it("never defers the search tool", () => {
    const { body } = shapeAnthropicRequest(req(), { toolSearch: { variant: "regex", keepLoaded: [] } });
    expect(body.tools[0].defer_loading).toBeUndefined();
  });

  it("never defers a tool carrying a cache breakpoint - the API rejects that pairing", () => {
    const withBreak = req({
      tools: [{ name: "Bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
    });
    const { body } = shapeAnthropicRequest(withBreak, { toolSearch: { variant: "regex", keepLoaded: [] } });
    expect(body.tools.find((t: any) => t.name === "Bash").defer_loading).toBeUndefined();
  });

  it("does not double-inject when a search tool is already present", () => {
    const already = req({ tools: [TOOL_SEARCH_VARIANTS.regex, { name: "Bash", input_schema: { type: "object" } }] });
    const { body, changes } = shapeAnthropicRequest(already, { toolSearch: { variant: "regex", keepLoaded: [] } });
    expect(changes.toolSearch).toBeNull();
    expect(body).toBe(already);
  });

  it("leaves a request with no tools completely alone", () => {
    const bare = req({ tools: [] });
    const { body, changes } = shapeAnthropicRequest(bare, { toolSearch: { variant: "regex", keepLoaded: [] } });
    expect(changes.toolSearch).toBeNull();
    expect(body).toBe(bare);
  });
});

describe("both at once, and the round-trip detector", () => {
  it("applies TTL and deferral together", () => {
    const { body, changes } = shapeAnthropicRequest(req(), {
      cacheTtl: "1h", toolSearch: { variant: "regex", keepLoaded: ["Bash"] },
    });
    expect(changes.cacheTtl).toBeTruthy();
    expect(changes.toolSearch).toBeTruthy();
    expect(body.system[1].cache_control.ttl).toBe("1h");
    expect(body.tools[0].type).toBe("tool_search_tool_regex_20251119");
  });

  it("returns the body untouched when nothing is configured", () => {
    const original = req();
    const { body, changes } = shapeAnthropicRequest(original, {});
    expect(body).toBe(original);
    // Every lever the shaper has is reported, including the ones it did not pull.
    expect(changes).toEqual({ cacheTtl: null, toolSearch: null, staticPrefix: null });
  });

  it("reports tool-search blocks in a response", () => {
    const seen = describeToolSearchBlocks({
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_regex", input: { pattern: "web" } },
        { type: "tool_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "WebFetch" }] } },
      ],
    });
    expect(seen.serverToolUse).toEqual(["tool_search_tool_regex"]);
    expect(seen.searchResults).toEqual([["WebFetch"]]);
  });

  it("reports nothing for an ordinary response", () => {
    const seen = describeToolSearchBlocks({ content: [{ type: "text", text: "hello" }] });
    expect(seen.serverToolUse).toEqual([]);
    expect(seen.searchResults).toEqual([]);
  });
});
