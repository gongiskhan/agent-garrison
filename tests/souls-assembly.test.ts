import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSoulPrompt,
  findModesEntry,
  findOrchestratorEntryId,
  assembleSouls,
  mcpGatewayPresent
} from "../src/lib/souls";

const ROOT = join(__dirname, "..");
const SEED_MODES = join(ROOT, "fittings/seed/modes");

// Anchors from the real seed files (voice/shared-voice.md + souls/*.md).
const VOICE_ANCHOR = "thoughtful person speaks";
const STANCE: Record<string, string> = {
  gary: "Gary, the operative at rest",
  joe: "Joe, how the operative writes",
  james: "James, the face that feels most"
};

describe("souls assembly (s1c)", () => {
  it("composeSoulPrompt puts the shared voice once, then stance, caps, routing (identity-first)", () => {
    const out = composeSoulPrompt({
      sharedVoice: "VOICE_BLOCK speaks plainly",
      stance: "STANCE_BLOCK you are Joe",
      capabilitiesBlock: "- memory:local — recall",
      routingSection: "## Routing policy\nActive Profile: balanced"
    });
    expect(out.split("VOICE_BLOCK").length - 1).toBe(1);
    expect(out).toContain("STANCE_BLOCK");
    expect(out).toContain("memory:local");
    expect(out).toContain("Routing policy");
    expect(out.indexOf("VOICE_BLOCK")).toBeLessThan(out.indexOf("STANCE_BLOCK"));
    expect(out.indexOf("STANCE_BLOCK")).toBeLessThan(out.indexOf("Routing policy"));
  });

  it("composeSoulPrompt omits caps/routing cleanly when absent", () => {
    const out = composeSoulPrompt({ sharedVoice: "V", stance: "S", capabilitiesBlock: "", routingSection: null });
    expect(out).toContain("V");
    expect(out).toContain("S");
    expect(out).not.toContain("Tools and Faculties");
  });

  it("findModesEntry / findOrchestratorEntryId pick the right providers", () => {
    const entries = [
      { id: "model-router", metadata: { provides: [{ kind: "orchestrator", name: "model-router" }] } },
      { id: "modes", metadata: { provides: [{ kind: "modes", name: "modes" }] } },
      { id: "basic-memory", metadata: { provides: [{ kind: "memory-store", name: "basic" }] } }
    ];
    expect(findModesEntry(entries)?.id).toBe("modes");
    expect(findOrchestratorEntryId(entries)).toBe("model-router");
    expect(findModesEntry([{ id: "x", metadata: { provides: [] } }])).toBeNull();
  });

  it("assembleSouls composes 3 soul prompts from the seed fitting + returns the gateway config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-souls-"));
    const orchPrompt = join(dir, ".garrison", "assembled-system-prompt.md");
    const config = await assembleSouls({
      compositionDir: dir,
      modesDir: SEED_MODES,
      orchestratorPromptPath: orchPrompt,
      orchestratorFittingId: "model-router",
      capabilitiesBlock: "- memory:local — recall",
      routingSection: "## Routing policy\nActive Profile: balanced"
    });
    expect(config).not.toBeNull();
    expect(config!.orchestratorFittingId).toBe("model-router");
    expect(Object.keys(config!.souls).sort()).toEqual(["soul-gary", "soul-james", "soul-joe"]);
    for (const mode of ["gary", "joe", "james"]) {
      const p = join(dir, ".garrison", "souls", `${mode}.md`);
      expect(existsSync(p), p).toBe(true);
      const text = readFileSync(p, "utf8");
      expect(text.split(VOICE_ANCHOR).length - 1, `${mode} voice once`).toBe(1);
      expect(text, mode).toContain(STANCE[mode]);
      expect(text).toContain("memory:local");
      expect(text).toContain("Routing policy");
      expect(config!.souls[`soul-${mode}`].promptPath).toBe(p);
      expect(config!.souls[`soul-${mode}`].preset).toBe("claude_code");
    }
    expect(config!.orchestrator.promptPath).toBe(orchPrompt);
  });

  it("assembleSouls returns null when the dir has no modes.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-nomodes-"));
    const config = await assembleSouls({
      compositionDir: dir,
      modesDir: dir,
      orchestratorPromptPath: join(dir, "p.md"),
      orchestratorFittingId: "model-router",
      capabilitiesBlock: "",
      routingSection: null
    });
    expect(config).toBeNull();
  });

  it("mcpGatewayPresent detects the sidecar (gates orchestrator-mode activation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-mcp-"));
    expect(await mcpGatewayPresent(dir)).toBe(false);
    mkdirSync(join(dir, "apm_modules", "_local", "mcp-gateway", "scripts"), { recursive: true });
    writeFileSync(join(dir, "apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs"), "// stub", "utf8");
    expect(await mcpGatewayPresent(dir)).toBe(true);
  });
});
