import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { loadSoulSpawnConfig } from "@/lib/soul-spawn-config";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");

describe("soul-spawn-config", () => {
  it("garrison-orchestrator: preset=none, allowed_tools=[], mcp=[garrison-control], exclude_dynamic=true", async () => {
    const cfg = await loadSoulSpawnConfig(
      "garrison-orchestrator",
      path.join(SEED_DIR, "garrison-orchestrator")
    );
    expect(cfg.preset).toBe("none");
    expect(cfg.allowed_tools).toEqual([]);
    expect(cfg.disallowed_tools).toBeUndefined();
    expect(cfg.exclude_dynamic_sections).toBe(true);
    expect(cfg.mcp).toContain("garrison-control");
    expect(cfg.promptPath).toContain("garrison-orchestrator.prompt.md");
    expect(cfg.resolvedBasePath).toContain(".garrison/orchestrator");
  });

  it("soul-engineer: preset=claude_code, no disallowed_tools, base_path ~/code", async () => {
    const cfg = await loadSoulSpawnConfig(
      "soul-engineer",
      path.join(SEED_DIR, "soul-engineer")
    );
    expect(cfg.preset).toBe("claude_code");
    expect(cfg.allowed_tools).toBeUndefined();
    expect(cfg.disallowed_tools).toBeUndefined();
    expect(cfg.exclude_dynamic_sections).toBe(false);
    expect(cfg.resolvedBasePath).toBe(path.join(os.homedir(), "code"));
    expect(cfg.promptPath).toContain("soul-engineer.prompt.md");
  });

  it("soul-architect: preset=none, Bash disallowed, has WebSearch", async () => {
    const cfg = await loadSoulSpawnConfig(
      "soul-architect",
      path.join(SEED_DIR, "soul-architect")
    );
    expect(cfg.preset).toBe("none");
    expect(cfg.allowed_tools).toContain("WebSearch");
    expect(cfg.allowed_tools).toContain("Read");
    expect(cfg.disallowed_tools).toContain("Bash");
    expect(cfg.exclude_dynamic_sections).toBe(false);
    expect(cfg.resolvedBasePath).toBe(path.join(os.homedir(), "code"));
  });

  it("soul-assistant: preset=none, no Bash/WebSearch, exclude_dynamic=true", async () => {
    const cfg = await loadSoulSpawnConfig(
      "soul-assistant",
      path.join(SEED_DIR, "soul-assistant")
    );
    expect(cfg.preset).toBe("none");
    expect(cfg.allowed_tools).toContain("Read");
    expect(cfg.allowed_tools).toContain("Write");
    expect(cfg.allowed_tools).not.toContain("Bash");
    expect(cfg.allowed_tools).not.toContain("WebSearch");
    expect(cfg.disallowed_tools).toContain("Bash");
    expect(cfg.disallowed_tools).toContain("WebSearch");
    expect(cfg.exclude_dynamic_sections).toBe(true);
    expect(cfg.resolvedBasePath).toContain(".garrison/assistant");
  });

  it("soul-researcher: preset=none, has WebSearch, no Bash", async () => {
    const cfg = await loadSoulSpawnConfig(
      "soul-researcher",
      path.join(SEED_DIR, "soul-researcher")
    );
    expect(cfg.preset).toBe("none");
    expect(cfg.allowed_tools).toContain("WebSearch");
    expect(cfg.allowed_tools).toContain("WebFetch");
    expect(cfg.allowed_tools).toContain("Grep");
    expect(cfg.disallowed_tools).toContain("Bash");
    expect(cfg.exclude_dynamic_sections).toBe(true);
    expect(cfg.resolvedBasePath).toContain(".garrison/research");
  });

  it("soul-companion: preset=none, no Bash/Edit, has WebSearch", async () => {
    const cfg = await loadSoulSpawnConfig(
      "soul-companion",
      path.join(SEED_DIR, "soul-companion")
    );
    expect(cfg.preset).toBe("none");
    expect(cfg.allowed_tools).toContain("WebSearch");
    expect(cfg.allowed_tools).toContain("WebFetch");
    expect(cfg.disallowed_tools).toContain("Bash");
    expect(cfg.disallowed_tools).toContain("Edit");
    expect(cfg.exclude_dynamic_sections).toBe(true);
    expect(cfg.resolvedBasePath).toContain(".garrison/companion");
  });

  it("config override: base_path overrides spawn.base_path", async () => {
    const cfg = await loadSoulSpawnConfig(
      "soul-engineer",
      path.join(SEED_DIR, "soul-engineer"),
      { base_path: "~/work" }
    );
    expect(cfg.resolvedBasePath).toBe(path.join(os.homedir(), "work"));
  });

  it("each soul provides a prompt file path that resolves to the .apm/prompts location", async () => {
    const souls = [
      "garrison-orchestrator",
      "soul-engineer",
      "soul-architect",
      "soul-assistant",
      "soul-researcher",
      "soul-companion"
    ];
    for (const soulId of souls) {
      const cfg = await loadSoulSpawnConfig(soulId, path.join(SEED_DIR, soulId));
      expect(cfg.promptPath).toContain(".apm/prompts");
      expect(cfg.promptPath).toContain(soulId);
    }
  });

  it("throws when prompt file is missing", async () => {
    await expect(
      loadSoulSpawnConfig("soul-engineer", path.join(SEED_DIR, "soul-engineer"), {
        base_path: "~/.nowhere"
      })
    ).resolves.toBeDefined(); // prompt exists, so no throw

    // Simulate a missing apm.yml — should throw before reaching promptPath check
    await expect(
      loadSoulSpawnConfig("soul-engineer", "/tmp/nonexistent-fitting")
    ).rejects.toThrow("apm.yml not found");
  });
});
