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
    expect(Object.keys(byKey).sort()).toEqual(["account", "base_url", "model", "provider"]);

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

  it("the Runtime-Faculty peer set is all selectable in the library (claude-code/agent-sdk/codex/gemini/opencode)", async () => {
    const lib = await readLibrary();
    const ids = new Set(lib.map((e) => e.id));
    for (const peer of ["claude-code-runtime", "agent-sdk-runtime", "codex-runtime", "gemini-runtime", "opencode-runtime"]) {
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

// S1 (GARRISON-RUNTIMES-V1): the fitting declares its provider mechanism (D3)
// and Quarters descriptor (D5), and the seed composition selects it so existing
// setups resolve with claude-code as an explicit first-class runtime.
describe("claude-code-runtime RUNTIMES-V1 metadata (S1)", () => {
  it("declares the env provider mechanism (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / --model)", async () => {
    const m = await loadSeed("claude-code-runtime");
    expect(m.provider_mechanism).toEqual({
      type: "env",
      base_url_env: "ANTHROPIC_BASE_URL",
      auth_env: "ANTHROPIC_AUTH_TOKEN",
      model_arg: "--model"
    });
  });

  it("declares the deep claude-code Quarters descriptor", async () => {
    const m = await loadSeed("claude-code-runtime");
    expect(m.quarters_descriptor).toEqual({ tier: "deep", id: "claude-code" });
  });

  it("is selected in the default composition's runtimes faculty", async () => {
    interface CompositionManifest {
      dependencies?: { apm?: Array<{ path?: string }> };
      "x-garrison"?: {
        composition?: { selections?: Record<string, Array<{ id: string }>> };
      };
    }
    const comp = await readYamlFile<CompositionManifest>(
      path.resolve(__dirname, "..", "compositions", "default", "apm.yml")
    );
    expect(comp).toBeTruthy();
    const deps = comp!.dependencies?.apm ?? [];
    expect(
      deps.some((d) => d.path === "../../fittings/seed/claude-code-runtime"),
      "default composition should depend on the claude-code-runtime seed"
    ).toBe(true);
    const runtimes = comp!["x-garrison"]?.composition?.selections?.runtimes ?? [];
    expect(
      runtimes.some((r) => r.id === "claude-code-runtime"),
      "default composition should select claude-code-runtime under runtimes"
    ).toBe(true);
  });
});

// S6 (GARRISON-RUNTIMES-V1): codex + gemini ship generic Quarters descriptors
// pointing at their REAL native surfaces (verified against the installed CLIs).
describe("codex + gemini quarters descriptors (S6)", () => {
  it("codex: generic tier over ~/.codex — config.toml (toml) + AGENTS.md + mcp_servers + logs", async () => {
    const m = await loadSeed("codex-runtime");
    const qd = m.quarters_descriptor!;
    expect(qd.tier).toBe("generic");
    if (qd.tier === "generic") {
      expect(qd.home_dir).toBe("~/.codex");
      expect(qd.settings_files?.[0]).toMatchObject({ path: "~/.codex/config.toml", format: "toml" });
      expect(qd.context_file).toBe("AGENTS.md");
      expect(qd.mcp_config).toMatchObject({ path: "~/.codex/config.toml", format: "toml", key: "mcp_servers" });
      expect(qd.categories).toEqual(["settings", "context", "mcps", "logs"]);
    }
    expect(m.provider_mechanism).toMatchObject({ type: "config-file", config_key: "model_providers" });
  });

  it("gemini: generic tier over ~/.gemini — settings.json (json) + GEMINI.md + mcpServers + logs", async () => {
    const m = await loadSeed("gemini-runtime");
    const qd = m.quarters_descriptor!;
    expect(qd.tier).toBe("generic");
    if (qd.tier === "generic") {
      expect(qd.home_dir).toBe("~/.gemini");
      expect(qd.settings_files?.[0]).toMatchObject({ path: "~/.gemini/settings.json", format: "json" });
      expect(qd.context_file).toBe("GEMINI.md");
      expect(qd.mcp_config).toMatchObject({ path: "~/.gemini/settings.json", format: "json", key: "mcpServers" });
    }
  });
});
