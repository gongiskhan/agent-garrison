import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { resolveCapabilities } from "@/lib/capabilities";
import type { GarrisonMetadata } from "@/lib/types";
import { readYamlFile } from "@/lib/yaml";
import { readLibrary } from "@/lib/library";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");

interface RawManifest {
  "x-garrison"?: unknown;
}

async function loadSeed(id: string): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<RawManifest>(path.join(SEED_DIR, id, "apm.yml"));
  expect(manifest, `seed ${id} should have an apm.yml`).toBeTruthy();
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

describe("claude-code-runtime fitting (S1)", () => {
  it("parses under the runtimes faculty and provides runtime:claude-code", async () => {
    const m = await loadSeed("claude-code-runtime");
    expect(m.faculty).toBe("runtimes");
    expect(m.component_shape).toBe("cli-skill");
    // The Claude Code runtime IS the orchestrator engine, not an own-port viewer.
    expect(m.own_port).toBe(false);
    expect(m.provides).toContainEqual({ kind: "runtime", name: "claude-code" });
    expect(m.consumes).toContainEqual({ kind: "vault", cardinality: "optional-one" });
  });

  it("exposes provider/model/base_url config; provider is a select over the known PROVIDERS", async () => {
    const m = await loadSeed("claude-code-runtime");
    const byKey = Object.fromEntries(m.config_schema.map((f) => [f.key, f]));
    expect(Object.keys(byKey).sort()).toEqual(["base_url", "model", "provider"]);

    const provider = byKey.provider;
    expect(provider.type).toBe("select");
    expect(provider.default).toBe("anthropic-plan");
    expect(provider.options).toEqual(
      expect.arrayContaining(["anthropic-plan", "ollama-local", "deepseek", "zai-glm"])
    );

    const model = byKey.model;
    expect(model.type).toBe("select");
    expect(model.default).toBe("opus");
    expect(model.options).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"]));

    expect(byKey.base_url.type).toBe("string");
  });

  it("declares a verify hook (the runner refuses to ship a fitting without one)", async () => {
    const m = await loadSeed("claude-code-runtime");
    expect(m.verify?.command).toContain("probe.mjs");
    expect(m.verify?.expect).toBe("ok");
  });

  it("is registered in the curated library, pointing at the seed dir", async () => {
    const lib = await readLibrary();
    const entry = lib.find((e) => e.id === "claude-code-runtime");
    expect(entry, "claude-code-runtime should be in data/library.json").toBeTruthy();
    expect(entry!.localPath).toBe("fittings/seed/claude-code-runtime");
  });

  it("the Runtime-Faculty peer set is all selectable in the library (claude-code/agent-sdk/codex/gemini)", async () => {
    const lib = await readLibrary();
    const ids = new Set(lib.map((e) => e.id));
    for (const peer of ["claude-code-runtime", "agent-sdk-runtime", "codex-runtime", "gemini-runtime"]) {
      expect(ids.has(peer), `${peer} should be a selectable runtime in data/library.json`).toBe(true);
    }
  });

  it("resolves capabilities cleanly on its own (runtime provider + optional vault)", async () => {
    const m = await loadSeed("claude-code-runtime");
    const result = resolveCapabilities([{ id: "claude-code-runtime", metadata: m }]);
    if (!result.ok) {
      throw new Error(`expected a clean resolve; got ${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });
});
