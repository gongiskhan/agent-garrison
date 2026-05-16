import { describe, expect, it } from "vitest";
import path from "node:path";

const LIB = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib");

// Phase 9I L1 — buildClaudeArgs / disallowedToolsForSoul are the heart of how
// the http-gateway converts a SpawnConfig + tier into a `claude` invocation.
// These assertions lock the contract that Phase 9D wires up.

const GARRISON_CONTROL_TOOLS = [
  "mcp__garrison__talk_to",
  "mcp__garrison__wait_for",
  "mcp__garrison__list_active_sessions",
  "mcp__garrison__end_session",
  "mcp__garrison__list_workdirs",
  "mcp__garrison__list_worktrees",
  "mcp__garrison__create_worktree",
  "mcp__garrison__get_worktree",
  "mcp__garrison__close_worktree"
];

describe("Phase 9I L1 — spawn-soul args", () => {
  describe("disallowedToolsForSoul", () => {
    it("always includes every garrison-control tool, even when SpawnConfig has none", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const disallowed = mod.disallowedToolsForSoul({});
      for (const tool of GARRISON_CONTROL_TOOLS) {
        expect(disallowed).toContain(tool);
      }
    });

    it("preserves SpawnConfig.disallowed_tools alongside the garrison-control set", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const disallowed = mod.disallowedToolsForSoul({ disallowed_tools: ["Bash", "WebSearch"] });
      expect(disallowed).toContain("Bash");
      expect(disallowed).toContain("WebSearch");
      for (const tool of GARRISON_CONTROL_TOOLS) {
        expect(disallowed).toContain(tool);
      }
    });

    it("deduplicates if a SpawnConfig disallow overlaps a garrison-control tool", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const disallowed = mod.disallowedToolsForSoul({
        disallowed_tools: ["mcp__garrison__talk_to", "Bash"]
      });
      const talkToCount = disallowed.filter((t: string) => t === "mcp__garrison__talk_to").length;
      expect(talkToCount).toBe(1);
    });
  });

  describe("disallowedToolsForOrchestrator", () => {
    it("does NOT include garrison-control tools (the orchestrator needs them)", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const disallowed = mod.disallowedToolsForOrchestrator({});
      for (const tool of GARRISON_CONTROL_TOOLS) {
        expect(disallowed).not.toContain(tool);
      }
    });

    it("honors any orchestrator-side disallowed_tools setting", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const disallowed = mod.disallowedToolsForOrchestrator({ disallowed_tools: ["Bash"] });
      expect(disallowed).toEqual(["Bash"]);
    });
  });

  describe("buildClaudeArgs", () => {
    it("uses --session-id on fresh spawn and --resume on a resume", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const fresh = mod.buildClaudeArgs({
        sessionUuid: "abc-123",
        spawnConfig: { preset: "claude_code" },
        resume: false,
        promptPath: "/tmp/p"
      });
      expect(fresh).toContain("--session-id");
      expect(fresh).toContain("abc-123");
      expect(fresh).not.toContain("--resume");

      const resumed = mod.buildClaudeArgs({
        sessionUuid: "abc-123",
        spawnConfig: { preset: "claude_code" },
        resume: true,
        promptPath: "/tmp/p"
      });
      expect(resumed).toContain("--resume");
      expect(resumed).toContain("abc-123");
      expect(resumed).not.toContain("--session-id");
    });

    it("appends the system prompt file when promptPath is provided", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const args = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "claude_code" },
        promptPath: "/tmp/soul-prompt.txt"
      });
      const idx = args.indexOf("--append-system-prompt-file");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("/tmp/soul-prompt.txt");
    });

    it("emits --exclude-dynamic-system-prompt-sections when spawnConfig requests it AND preset is claude_code", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const args = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "claude_code", exclude_dynamic_sections: true },
        promptPath: "/tmp/p"
      });
      expect(args).toContain("--exclude-dynamic-system-prompt-sections");
    });

    it("does NOT emit --exclude-dynamic-system-prompt-sections when preset is none (the flag is ignored there)", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const args = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "none", exclude_dynamic_sections: true },
        promptPath: "/tmp/p"
      });
      expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
    });

    it("attaches --mcp-config and --strict-mcp-config when mcpConfigPath is given", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const args = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "claude_code" },
        mcpConfigPath: "/tmp/.garrison/mcp.json",
        promptPath: "/tmp/p"
      });
      expect(args).toContain("--mcp-config");
      expect(args).toContain("/tmp/.garrison/mcp.json");
      expect(args).toContain("--strict-mcp-config");
    });

    it("attaches tierFlags verbatim at the end of the argv", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const args = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "claude_code" },
        tierFlags: ["--model", "claude-opus-4-7"],
        promptPath: "/tmp/p"
      });
      const modelIdx = args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe("claude-opus-4-7");
    });

    it("disallows the 9 garrison-control tools for souls but NOT for orchestrators", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const soulArgs = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "claude_code" },
        isOrchestrator: false,
        promptPath: "/tmp/p"
      });
      const orchArgs = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "none" },
        isOrchestrator: true,
        promptPath: "/tmp/p"
      });

      const soulDisIdx = soulArgs.indexOf("--disallowedTools");
      expect(soulDisIdx).toBeGreaterThanOrEqual(0);
      const soulDisValue = soulArgs[soulDisIdx + 1];
      expect(soulDisValue).toContain("mcp__garrison__talk_to");
      expect(soulDisValue).toContain("mcp__garrison__close_worktree");

      const orchDisIdx = orchArgs.indexOf("--disallowedTools");
      expect(orchDisIdx).toBe(-1); // no disallowed tools by default for orchestrator
    });

    it("emits --allowedTools as comma-separated when SpawnConfig.allowed_tools is non-empty", async () => {
      const mod = await import(path.join(LIB, "spawn-soul.mjs"));
      const args = mod.buildClaudeArgs({
        sessionUuid: "x",
        spawnConfig: { preset: "claude_code", allowed_tools: ["Read", "Edit", "Bash"] },
        promptPath: "/tmp/p"
      });
      const idx = args.indexOf("--allowedTools");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("Read,Edit,Bash");
    });
  });
});
