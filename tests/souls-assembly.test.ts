import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSoulPrompt,
  composeOrchestratorPrompt,
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
    mkdirSync(join(dir, ".garrison"), { recursive: true });
    writeFileSync(orchPrompt, "# BASE ORCH PROMPT\n[orchestrator-active]\n", "utf8");
    const config = await assembleSouls({
      compositionDir: dir,
      modesDir: SEED_MODES,
      orchestratorPromptPath: orchPrompt,
      orchestratorFittingId: "model-router",
      capabilitiesBlock: "- memory:local — recall",
      routingSection: "## Routing policy\nActive Profile: balanced",
      routingCorePath: join(ROOT, "fittings/seed/model-router/lib/routing-core.mjs")
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
    // orchestrator prompt for soul mode = base assembled prompt + mode-delegation
    const orchComposedPath = join(dir, ".garrison", "souls", "_orchestrator.md");
    expect(config!.orchestrator.promptPath).toBe(orchComposedPath);
    const orchText = readFileSync(orchComposedPath, "utf8");
    expect(orchText).toContain("BASE ORCH PROMPT");
    expect(orchText).toContain("Mode delegation");
    expect(orchText).toContain("talk_to");
    // modes meta carried for the gateway mode-resolver (s1d)
    expect(config!.modes.names.sort()).toEqual(["gary", "james", "joe"]);
    expect(config!.modes.channelDefaults["dev-env"]).toBe("joe");
    expect(config!.modes.channelDefaults.slack).toBe("gary");
    expect(config!.modes.defaultMode).toBe("gary");
    expect(config!.modes.switchLogPath).toBe(join(dir, ".garrison", "switch-log.jsonl"));
    // per-mode tier from routing bias (s1e), surfaced into the orchestrator prompt
    expect(config!.modes.tierByMode).toMatchObject({ joe: "expert", james: "standard", gary: "standard" });
    expect(orchText).toContain("Per-mode tier");
    expect(orchText).toContain("joe: spawn at the **expert** tier");
  });

  it("composeOrchestratorPrompt appends the mode-delegation (talk_to) instruction to the base", () => {
    const out = composeOrchestratorPrompt("# Base orchestrator\n[orchestrator-active]");
    expect(out).toContain("Base orchestrator");
    expect(out).toContain("Mode delegation");
    expect(out).toContain("talk_to(soul=<name>");
    expect(out).toContain("share one memory");
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

// s1c cross-model gate (Codex r1): the souls-activation gate must be REACHABLE and
// the orchestrator-fitting-id env contract must be wired on BOTH ends, or souls mode
// is unreachable dead wiring. These are source-invariants (the gateway boot path is
// heavy to instantiate; assembleSouls semantics are covered above).
describe("souls wiring contract (s1c cross-model gate)", () => {
  it("mcp-gateway is registered in the library so the souls-activation gate is satisfiable (f1)", () => {
    const lib = JSON.parse(readFileSync(join(ROOT, "data/library.json"), "utf8"));
    const ids = lib.map((e: { id: string }) => e.id);
    // activation gates on mcpGatewayPresent — a user composing modes must be able to
    // ADD mcp-gateway, so it has to exist in the curated library (not just on disk).
    expect(ids).toContain("mcp-gateway");
  });

  it("GARRISON_ORCHESTRATOR_FITTING_ID is set by the runner AND read by the gateway (f3 — two-ended env contract)", () => {
    const runnerSrc = readFileSync(join(ROOT, "src/lib/runner.ts"), "utf8");
    const gatewaySrc = readFileSync(join(ROOT, "fittings/seed/http-gateway/scripts/gateway.mjs"), "utf8");
    // runner must project the id into the gateway env (else the serialized
    // soulsConfig.orchestratorFittingId is dead and the orchestrator mislabels)
    expect(runnerSrc).toContain("GARRISON_ORCHESTRATOR_FITTING_ID: soulsConfig.orchestratorFittingId");
    // and the gateway must consume that exact env var
    expect(gatewaySrc).toContain("GARRISON_ORCHESTRATOR_FITTING_ID");
    // the silent-downgrade guard: when souls assembly yields null with modes present
    expect(runnerSrc).toContain("souls assembly produced no config");
  });
});
