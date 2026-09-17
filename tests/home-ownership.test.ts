import { expect, it } from "vitest";
import { withoutTomlMcp, selectedSharedSet } from "../src/lib/home-ownership";
it("removes only the owned MCP tables and keeps unrelated TOML bytes", () => {
  const prefix = '# user comment\nmodel = "mine"\n\n';
  const own = '[mcp_servers."basic-memory"]\ncommand = "bm"\n[mcp_servers."basic-memory".env]\nX = "1"\n';
  const suffix = '\n[mcp_servers.mine]\ncommand = "mine"\n[projects."/scratch"]\ntrust_level = "trusted"\n';
  const result = withoutTomlMcp(prefix + own + suffix, "basic-memory");
  expect(result.bytes).toBe(prefix + suffix.slice(1));
  expect(result.removed).toBe(own + '\n');
});
it("refuses unsupported inline ownership removal rather than rewriting user config", () => {
  expect(() => withoutTomlMcp('mcp_servers = { owned = { command = "x" }, mine = { command = "y" } }\n', "owned")).toThrow("left untouched");
});
it("uses only explicit selection sharing and de-duplicates a fitting across slots", () => {
  expect(selectedSharedSet({ memory: [{ id: "a", config: {}, shared: ["claude-code", "codex"] }], coordination: [{ id: "a", config: {}, shared: ["codex"] }, { id: "b", config: {} }] })).toEqual({ "claude-code": ["a"], codex: ["a"], gemini: [] });
});
