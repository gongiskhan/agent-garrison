import { describe, expect, it } from "vitest";
import { shippedCompositionIds } from "./helpers/shipped-compositions";
import fs from "node:fs/promises";
import path from "node:path";
import { readRawLibrary } from "@/lib/library";
import { readComposition, selectedLibraryEntries } from "@/lib/compositions";
import { resolveModel } from "@/lib/resolver";

// Read from disk rather than frozen here: this suite asserts properties EVERY
// shipped composition must hold, so a retired one must drop out silently and a new
// one must be covered the day it lands. A hardcoded list did the opposite - it
// kept failing on compositions that no longer existed.
const COMPOSITIONS = shippedCompositionIds();

// The subset that runs the Anthropic-plan default stack. A composition that
// deliberately runs another engine (the OpenAI one) is excluded by its own
// primaryRuntime, not by being named here.
const ACTIVE_DEFAULT_COMPOSITIONS = COMPOSITIONS;

describe("Orchestrator-owned routing and identity", () => {
  // "identity-gary" is the id this fitting shipped under, kept verbatim: the
  // operative's rename to Zeca does not rename a fitting that no longer exists.
  it("retires the standalone Dispatcher and Identity Gary fittings from the public library", async () => {
    const ids = (await readRawLibrary()).map((entry) => entry.id);
    expect(ids).not.toContain("dispatcher");
    expect(ids).not.toContain("identity-gary");
  });

  for (const compositionId of COMPOSITIONS) {
    it(`${compositionId} resolves ready with one dispatch provider`, async () => {
      const composition = await readComposition(compositionId);
      const entries = await selectedLibraryEntries(composition.selections);
      const model = resolveModel({
        fittings: entries.map((entry) => ({ id: entry.id, metadata: entry.metadata })),
        compositionDuties: composition.duties,
        selectedDuties: composition.selectedDuties
      });

      expect(model.errors.filter((error) => error.code === "duplicate-duty")).toEqual([]);
      expect(model.duties.dispatch?.providerFittingId).toBe("orchestrator");
      expect(model.rules.find((result) => result.rule.id === "identity")?.met).toBe(true);
      expect(model.rules.find((result) => result.rule.id === "routing-inference")?.met).toBe(true);
      expect(model.rules.filter((result) => !result.met).map((result) => result.rule.id)).toEqual([]);
      expect(model.ready).toBe(true);
    });
  }

  it("ships no active Ollama or Qwen route in defaults, dogfood, or the Orchestrator seed", async () => {
    for (const compositionId of ACTIVE_DEFAULT_COMPOSITIONS) {
      const composition = await readComposition(compositionId);
      const activeConfiguration = JSON.stringify({
        selections: composition.selections,
        duties: composition.duties,
        targets: composition.targets
      });
      expect(activeConfiguration, compositionId).not.toMatch(/ollama|qwen/i);
      // Every composition must carry a dispatch target, and it must be a real
      // engine with a real model. Which engine is the composition's business -
      // pinning "agent-sdk/anthropic" here made an all-OpenAI composition fail a
      // test whose actual subject is "no ollama, no qwen".
      const dispatch = composition.targets.find((target) => target.id === "dispatch-fast");
      expect(dispatch, `${compositionId} must ship a dispatch-fast target`).toBeTruthy();
      expect(dispatch?.runtime, compositionId).toBeTruthy();
      expect(dispatch?.model, compositionId).toBeTruthy();
    }

    const seed = await fs.readFile(
      path.join(process.cwd(), "fittings/seed/orchestrator/config/routing.seed.json"),
      "utf8"
    );
    expect(seed).not.toMatch(/ollama|qwen/i);
  });

  it("keeps retired routing/persona concepts off active public surfaces", async () => {
    const files = {
      site: await fs.readFile(path.join(process.cwd(), "site/index.html"), "utf8"),
      library: await fs.readFile(path.join(process.cwd(), "data/library.json"), "utf8"),
      mcpManifest: await fs.readFile(path.join(process.cwd(), "fittings/seed/mcp-gateway/apm.yml"), "utf8"),
      mcpGateway: await fs.readFile(path.join(process.cwd(), "fittings/seed/mcp-gateway/scripts/gateway.mjs"), "utf8"),
      // csg/glm policies used to be read here; both compositions were retired, and
      // a file that no longer exists cannot carry a retired concept.
      routerCatalog: await fs.readFile(path.join(process.cwd(), "fittings/seed/orchestrator/routing.json"), "utf8"),
      assistantManifest: await fs.readFile(path.join(process.cwd(), "fittings/seed/garrison-assistant/apm.yml"), "utf8"),
      opencodeManifest: await fs.readFile(path.join(process.cwd(), "fittings/seed/opencode-runtime/apm.yml"), "utf8"),
      opencodeBridge: await fs.readFile(path.join(process.cwd(), "fittings/seed/opencode-runtime/scripts/bridge.mjs"), "utf8")
    };

    expect(files.site).not.toMatch(/\b(?:Joe|James|Dispatcher|Ollama)\b/);
    expect(files.library).not.toMatch(/soul-mode|talk_to|wait_for/);
    expect(`${files.mcpManifest}\n${files.mcpGateway}`).not.toMatch(/soul-mode|Soul sub-session|talk_to|wait_for|by-soul/);
    expect(files.routerCatalog).not.toMatch(/ollama|qwen/i);
    expect(`${files.assistantManifest}\n${files.opencodeManifest}\n${files.opencodeBridge}`).not.toMatch(/ollama|qwen/i);
  });
});
