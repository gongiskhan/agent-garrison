import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readRawLibrary } from "@/lib/library";
import { readComposition, selectedLibraryEntries } from "@/lib/compositions";
import { resolveModel } from "@/lib/resolver";

const COMPOSITIONS = [
  "default",
  "dogfood-dev",
  "glm",
  "csg",
  "default-build",
  "default-economy",
  "default-premium"
] as const;

const ACTIVE_DEFAULT_COMPOSITIONS = [
  "default",
  "dogfood-dev",
  "default-build",
  "default-economy",
  "default-premium"
] as const;

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
      expect(composition.targets.find((target) => target.id === "dispatch-fast")).toMatchObject({
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-haiku-4-5"
      });
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
      csgPolicy: await fs.readFile(path.join(process.cwd(), "compositions/csg/routing.cursor-only.json"), "utf8"),
      glmPolicy: await fs.readFile(path.join(process.cwd(), "compositions/glm/routing.glm-only.json"), "utf8"),
      routerCatalog: await fs.readFile(path.join(process.cwd(), "fittings/seed/orchestrator/routing.json"), "utf8"),
      assistantManifest: await fs.readFile(path.join(process.cwd(), "fittings/seed/garrison-assistant/apm.yml"), "utf8"),
      opencodeManifest: await fs.readFile(path.join(process.cwd(), "fittings/seed/opencode-runtime/apm.yml"), "utf8"),
      opencodeBridge: await fs.readFile(path.join(process.cwd(), "fittings/seed/opencode-runtime/scripts/bridge.mjs"), "utf8")
    };

    expect(files.site).not.toMatch(/\b(?:Joe|James|Dispatcher|Ollama)\b/);
    expect(files.library).not.toMatch(/soul-mode|talk_to|wait_for/);
    expect(`${files.mcpManifest}\n${files.mcpGateway}`).not.toMatch(/soul-mode|Soul sub-session|talk_to|wait_for|by-soul/);
    expect(`${files.csgPolicy}\n${files.glmPolicy}\n${files.routerCatalog}`).not.toMatch(/ollama|qwen/i);
    expect(`${files.assistantManifest}\n${files.opencodeManifest}\n${files.opencodeBridge}`).not.toMatch(/ollama|qwen/i);
  });
});
