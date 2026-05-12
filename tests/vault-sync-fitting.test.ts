import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYamlFile } from "@/lib/yaml";
import { parseGarrisonMetadata } from "@/lib/metadata";
import type { GarrisonMetadata } from "@/lib/types";

const FITTING_DIR = path.resolve("fittings/seed/vault-sync");

interface RawManifest {
  "x-garrison"?: unknown;
}

async function loadMetadata(): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<RawManifest>(
    path.join(FITTING_DIR, "apm.yml")
  );
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

describe("vault-sync apm.yml", () => {
  it("parses without throwing", async () => {
    await expect(loadMetadata()).resolves.toBeTruthy();
  });

  it("faculty is sync", async () => {
    const md = await loadMetadata();
    expect(md.faculty).toBe("sync");
  });

  it("component_shape is cli-skill", async () => {
    const md = await loadMetadata();
    expect(md.component_shape).toBe("cli-skill");
  });

  it("consumes outpost any and automation-runner one", async () => {
    const md = await loadMetadata();
    expect(
      md.consumes.some((c) => c.kind === "outpost" && c.cardinality === "any")
    ).toBe(true);
    expect(
      md.consumes.some(
        (c) => c.kind === "automation-runner" && c.cardinality === "one"
      )
    ).toBe(true);
  });

  it("config_schema has required source_dir and target_outposts fields", async () => {
    const md = await loadMetadata();
    expect(md.config_schema.some((f) => f.key === "source_dir" && f.required)).toBe(
      true
    );
    expect(
      md.config_schema.some((f) => f.key === "target_outposts" && f.required)
    ).toBe(true);
  });

  it("has a sidebar-surface UI view", async () => {
    const md = await loadMetadata();
    const views = md.ui?.views ?? [];
    expect(views.some((v) => v.placement === "sidebar-surface")).toBe(true);
  });
});

describe("vault-sync scripts exist", () => {
  it("sync.py exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "scripts", "sync.py"))
    ).toBe(true);
  });

  it("setup.sh exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "scripts", "setup.sh"))
    ).toBe(true);
  });

  it("verify.sh exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "scripts", "verify.sh"))
    ).toBe(true);
  });

  it("sync.sh exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "scripts", "sync.sh"))
    ).toBe(true);
  });

  it("VaultSyncStatus.tsx exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "ui", "VaultSyncStatus.tsx"))
    ).toBe(true);
  });
});
