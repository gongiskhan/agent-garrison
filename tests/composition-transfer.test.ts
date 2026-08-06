import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  BUNDLE_EXCLUSIONS,
  COMPOSITION_BUNDLE_KIND,
  COMPOSITION_BUNDLE_VERSION,
  bundleFileName,
  buildCompositionBundle,
  compositionExportPathAllowed,
  importComposition,
  inspectCompositionBundle,
  parseCompositionBundle,
  requiredSecretKeys,
  serializeBundle,
  type CompositionBundle
} from "@/lib/composition-transfer";
import { getCompositionDirectory } from "@/lib/compositions";
import type { GarrisonMetadata, LibraryEntry } from "@/lib/types";

const SOURCE_ID = `transfer-source-${process.pid}`;
const TARGET_ID = `transfer-target-${process.pid}`;
const SOURCE_DIR = getCompositionDirectory(SOURCE_ID);
const TARGET_DIR = getCompositionDirectory(TARGET_ID);

const SOURCE_MANIFEST = {
  name: SOURCE_ID,
  version: "0.1.0",
  target: "claude",
  dependencies: { apm: [{ path: "../../fittings/seed/orchestrator" }] },
  "x-garrison": {
    composition: {
      schema: 4,
      id: SOURCE_ID,
      name: "Transfer Source",
      global_config: { projects_root: "~/dev", vault: "default" },
      selections: {
        orchestrator: [{ id: "orchestrator", config: { port: 7087 } }],
        channels: [{ id: "not-on-this-machine", config: {} }]
      },
      duties: [
        {
          id: "implement",
          title: "Implement",
          description: "implement a change",
          levels: [{ description: "standard", cell: { effort: "medium" } }]
        }
      ],
      selected_duties: ["implement"],
      targets: [{ id: "sonnet", runtime: "claude-code-runtime", model: "sonnet" }],
      prompt_sources: {
        orchestrator: ".garrison/prompts/orchestrator.md"
      }
    }
  }
};

async function writeSource(): Promise<void> {
  await fs.rm(SOURCE_DIR, { recursive: true, force: true });
  await fs.rm(TARGET_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(SOURCE_DIR, ".garrison", "prompts"), { recursive: true });
  await fs.writeFile(path.join(SOURCE_DIR, "apm.yml"), yaml.dump(SOURCE_MANIFEST), "utf8");

  // Authored — must travel. The legacy identity file is migrated into the
  // canonical authored Orchestrator document before export, then excluded.
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "prompts", "orchestrator.md"), "authored prompt\n");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "prompts", "soul.md"), "authored soul\n");
  await fs.writeFile(
    path.join(SOURCE_DIR, ".garrison", "routing.json"),
    `${JSON.stringify({ policyVersion: 2, primaryRuntime: "codex-runtime" }, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(SOURCE_DIR, ".garrison", "orchestrator-authored.json"),
    `${JSON.stringify({ mission: "authored" })}\n`
  );
  await fs.writeFile(path.join(SOURCE_DIR, "profile.md"), "composition profile\n");
  await fs.writeFile(path.join(SOURCE_DIR, "routing.cursor-only.json"), `${JSON.stringify({ alt: true })}\n`);

  // Machine-local and generated — must NOT travel.
  await fs.writeFile(path.join(SOURCE_DIR, ".env"), "ANTHROPIC_API_KEY=sk-do-not-share\n");
  await fs.writeFile(path.join(SOURCE_DIR, "local.yml"), "global_config:\n  projects_root: /home/someone/dev\n");
  await fs.writeFile(path.join(SOURCE_DIR, "apm.lock.yaml"), "resolved: true\n");
  await fs.mkdir(path.join(SOURCE_DIR, ".garrison", "souls"), { recursive: true });
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "souls", "gary.md"), "generated soul\n");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "decisions.jsonl"), "{}\n");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "owner.json"), `${JSON.stringify({ instanceId: "dev" })}`);
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "assembled-system-prompt.md"), "generated\n");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "routing.json.v1.bak"), "{}\n");
  await fs.mkdir(path.join(SOURCE_DIR, "apm_modules", "_local"), { recursive: true });
  await fs.writeFile(path.join(SOURCE_DIR, "apm_modules", "_local", "installed.md"), "generated\n");
}

function bundlePaths(bundle: CompositionBundle): string[] {
  return bundle.files.map((file) => file.path).sort();
}

beforeEach(writeSource);
afterAll(async () => {
  await fs.rm(SOURCE_DIR, { recursive: true, force: true });
  await fs.rm(TARGET_DIR, { recursive: true, force: true });
});

describe("compositionExportPathAllowed", () => {
  it("allows exactly the authored surface", () => {
    for (const allowed of [
      "profile.md",
      "README.md",
      "AGENTS.md",
      "routing.cursor-only.json",
      ".garrison/routing.json",
      ".garrison/orchestrator-authored.json",
      ".garrison/prompts/orchestrator.md"
    ]) {
      expect(compositionExportPathAllowed(allowed), allowed).toBe(true);
    }
  });

  it("refuses secrets, machine-local state, generated files and traversal", () => {
    for (const denied of [
      ".env",
      "local.yml",
      "apm.lock.yaml",
      "apm.yml",
      ".garrison/souls/gary.md",
      ".garrison/prompts/soul.md",
      ".garrison/decisions.jsonl",
      ".garrison/owner.json",
      ".garrison/policy.json",
      ".garrison/assembled-system-prompt.md",
      ".garrison/routing.json.v1.bak",
      ".garrison/operative-session-id",
      "apm_modules/_local/installed.md",
      ".claude/settings.json",
      "../../fittings/seed/evil/apm.yml",
      "/etc/passwd",
      ".garrison/prompts/../../../escape.md",
      "nested/dir/profile.md",
      ""
    ]) {
      expect(compositionExportPathAllowed(denied), denied).toBe(false);
    }
  });
});

describe("buildCompositionBundle", () => {
  it("carries the manifest and every authored file", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);

    expect(bundle.kind).toBe(COMPOSITION_BUNDLE_KIND);
    expect(bundle.version).toBe(COMPOSITION_BUNDLE_VERSION);
    expect(bundle.composition).toMatchObject({ id: SOURCE_ID, name: "Transfer Source", schema: 4 });
    expect(bundlePaths(bundle)).toEqual([
      ".garrison/orchestrator-authored.json",
      ".garrison/prompts/orchestrator.md",
      ".garrison/routing.json",
      "profile.md",
      "routing.cursor-only.json"
    ]);
    const routing = bundle.files.find((f) => f.path === ".garrison/routing.json");
    expect(JSON.parse(routing?.contents ?? "{}")).toMatchObject({ primaryRuntime: "codex-runtime" });
    const authored = bundle.files.find((f) => f.path === ".garrison/orchestrator-authored.json");
    expect(JSON.parse(authored?.contents ?? "{}")).toMatchObject({ mission: "authored", identity: "authored soul" });
    await expect(fs.access(path.join(SOURCE_DIR, ".garrison", "prompts", "soul.md"))).rejects.toThrow();
    // The manifest travels whole: duties, targets and per-fitting config too.
    const block = (bundle.manifest["x-garrison"] as { composition: Record<string, unknown> }).composition;
    expect(block.duties).toHaveLength(1);
    expect(block.targets).toHaveLength(1);
    expect(bundle.excluded).toEqual([...BUNDLE_EXCLUSIONS]);
    expect(bundleFileName(bundle)).toBe(`${SOURCE_ID}.garrison.json`);
  });

  it("never carries secrets, the machine-local overlay, the lockfile or generated state", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const serialized = serializeBundle(bundle);

    for (const leaked of [
      ".env",
      "local.yml",
      "apm.lock.yaml",
      ".garrison/souls/gary.md",
      ".garrison/decisions.jsonl",
      ".garrison/owner.json",
      ".garrison/assembled-system-prompt.md",
      ".garrison/routing.json.v1.bak",
      "apm_modules/_local/installed.md"
    ]) {
      expect(bundlePaths(bundle)).not.toContain(leaked);
    }
    // The strongest form of the claim: the secret's VALUE appears nowhere in the
    // serialized document, whatever path it might have arrived by.
    expect(serialized).not.toContain("sk-do-not-share");
    expect(serialized).not.toContain("/home/someone/dev");
    expect(serialized).not.toContain("generated soul");
  });

  it("is deterministic - two exports of an unchanged composition match", async () => {
    const first = await buildCompositionBundle(SOURCE_ID);
    const second = await buildCompositionBundle(SOURCE_ID);
    const strip = (bundle: CompositionBundle) => ({ ...bundle, exported_at: "" });
    expect(strip(second.bundle)).toEqual(strip(first.bundle));
  });

  it("refuses a composition that is not there", async () => {
    await expect(buildCompositionBundle("no-such-composition-xyz")).rejects.toThrow(/does not exist/);
  });
});

describe("requiredSecretKeys", () => {
  function entry(id: string, metadata: Partial<GarrisonMetadata>): LibraryEntry {
    return {
      id,
      name: id,
      faculty: "channels",
      repo: `https://example.test/${id}`,
      summary: "",
      platforms: ["claude-code"],
      ratings: {},
      metadata: { config_schema: [], provides: [], consumes: [], ...metadata } as GarrisonMetadata
    } as LibraryEntry;
  }

  it("unions the fitting's scope with every secret-ref config value", () => {
    const library = [
      entry("slack-channel", {
        secret_scope: ["SLACK_BOT_TOKEN"],
        config_schema: [
          { key: "token_secret", type: "secret-ref", description: "bot token" },
          { key: "port", type: "integer", description: "listen port" }
        ] as GarrisonMetadata["config_schema"]
      })
    ];
    const keys = requiredSecretKeys(
      { channels: [{ id: "slack-channel", config: { token_secret: "SLACK_APP_TOKEN", port: 9512 } }] },
      library
    );
    // Sorted, deduped, and a non-secret-ref config value (the port) never leaks in.
    expect(keys).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  });

  it("ignores a fitting this machine does not have", () => {
    expect(requiredSecretKeys({ channels: [{ id: "unknown", config: {} }] }, [])).toEqual([]);
  });
});

describe("parseCompositionBundle", () => {
  it("rejects anything that is not a bundle, readably", () => {
    expect(() => parseCompositionBundle("not json at all")).toThrow(/not valid JSON/);
    expect(() => parseCompositionBundle({ hello: "world" })).toThrow(/not a Garrison composition bundle/);
    expect(() => parseCompositionBundle([1, 2, 3])).toThrow(/must be a JSON object/);
    expect(() =>
      parseCompositionBundle({ kind: COMPOSITION_BUNDLE_KIND, version: 99, composition: {}, manifest: {} })
    ).toThrow(/version 99/);
    expect(() =>
      parseCompositionBundle({ kind: COMPOSITION_BUNDLE_KIND, version: 1, manifest: {} })
    ).toThrow(/malformed at composition/);
  });

  it("accepts the JSON text of a real export", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    expect(parseCompositionBundle(serializeBundle(bundle)).composition.id).toBe(SOURCE_ID);
  });
});

describe("inspectCompositionBundle", () => {
  it("reports fittings this machine does not have without blocking the import", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const inspection = await inspectCompositionBundle(bundle, TARGET_ID);

    expect(inspection.errors).toEqual([]);
    expect(inspection.duties).toBe(1);
    expect(inspection.targets).toBe(1);
    expect(inspection.requestedIdAvailable).toBe(true);
    expect(inspection.suggestedId).toBe(TARGET_ID);
    const missing = inspection.fittings.find((f) => f.id === "not-on-this-machine");
    expect(missing?.present).toBe(false);
    expect(inspection.warnings.join(" ")).toMatch(/not-on-this-machine/);
  });

  it("suggests a free id when the requested one is taken", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const inspection = await inspectCompositionBundle(bundle, SOURCE_ID);
    expect(inspection.requestedIdAvailable).toBe(false);
    expect(inspection.suggestedId).toBe(`${SOURCE_ID}-2`);
  });

  it("refuses a bundle whose file paths escape the composition", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const hostile: CompositionBundle = {
      ...bundle,
      files: [{ path: "../../fittings/seed/orchestrator/apm.yml", contents: "owned: true\n" }]
    };
    const inspection = await inspectCompositionBundle(hostile, TARGET_ID);
    expect(inspection.errors.join(" ")).toMatch(/may not write/);
  });

  it("refuses a bundle whose manifest is not a composition", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const inspection = await inspectCompositionBundle({ ...bundle, manifest: { name: "x" } }, TARGET_ID);
    expect(inspection.errors.join(" ")).toMatch(/no x-garrison.composition block/);
  });
});

describe("importComposition", () => {
  it("round-trips a composition into a new id", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const imported = await importComposition({ bundle, id: TARGET_ID, name: "Imported Crew" });

    expect(imported.id).toBe(TARGET_ID);
    expect(imported.name).toBe("Imported Crew");
    expect(imported.selectedDuties).toEqual(["implement"]);
    expect(imported.targets).toHaveLength(1);

    const raw = yaml.load(await fs.readFile(path.join(TARGET_DIR, "apm.yml"), "utf8")) as {
      name: string;
      dependencies: { apm: Array<{ path: string }> };
      "x-garrison": { composition: { id: string; name: string } };
    };
    expect(raw["x-garrison"].composition).toMatchObject({ id: TARGET_ID, name: "Imported Crew" });
    expect(raw.name).toBe("imported-crew");
    // Dependency paths are composition-dir relative and the import lands as a
    // sibling, so they travel verbatim and still resolve.
    expect(raw.dependencies.apm).toEqual([{ path: "../../fittings/seed/orchestrator" }]);

    expect(await fs.readFile(path.join(TARGET_DIR, ".garrison", "prompts", "orchestrator.md"), "utf8")).toBe(
      "authored prompt\n"
    );
    expect(
      JSON.parse(await fs.readFile(path.join(TARGET_DIR, ".garrison", "routing.json"), "utf8"))
    ).toMatchObject({ primaryRuntime: "codex-runtime" });
    expect(await fs.readFile(path.join(TARGET_DIR, "profile.md"), "utf8")).toBe("composition profile\n");

    for (const rel of [".env", "local.yml", "apm.lock.yaml", ".garrison/souls", ".garrison/owner.json"]) {
      await expect(fs.access(path.join(TARGET_DIR, rel))).rejects.toThrow();
    }
  });

  it("refuses to overwrite an existing composition", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    await expect(importComposition({ bundle, id: SOURCE_ID })).rejects.toThrow(/already exists/);
    // The source is untouched: still its own name, still holding its .env.
    const raw = yaml.load(await fs.readFile(path.join(SOURCE_DIR, "apm.yml"), "utf8")) as {
      "x-garrison": { composition: { name: string } };
    };
    expect(raw["x-garrison"].composition.name).toBe("Transfer Source");
    expect(await fs.readFile(path.join(SOURCE_DIR, ".env"), "utf8")).toContain("sk-do-not-share");
  });

  it("refuses a hostile path and leaves nothing behind", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const hostile: CompositionBundle = {
      ...bundle,
      files: [{ path: "../../fittings/seed/orchestrator/apm.yml", contents: "owned: true\n" }]
    };
    await expect(importComposition({ bundle: hostile, id: TARGET_ID })).rejects.toThrow(/may not write/);
    await expect(fs.access(TARGET_DIR)).rejects.toThrow();
  });

  it("scaffolds prompts a bundle did not carry", async () => {
    const { bundle } = await buildCompositionBundle(SOURCE_ID);
    const bare: CompositionBundle = { ...bundle, files: [] };
    await importComposition({ bundle: bare, id: TARGET_ID, name: "Bare Import" });
    // ensureComposition backfills the defaults so the composition is runnable.
    expect(
      await fs.readFile(path.join(TARGET_DIR, ".garrison", "prompts", "orchestrator.md"), "utf8")
    ).toContain("Agent Garrison Orchestrator");
  });
});
