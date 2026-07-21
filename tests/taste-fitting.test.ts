import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";

const TASTE_DIR = path.resolve(__dirname, "..", "fittings", "seed", "taste");

interface RawManifest {
  "x-garrison"?: unknown;
}

interface UpstreamPin {
  repo: string;
  commit: string;
  license: string;
  files: Record<string, { sha256: string; upstreamPath: string }>;
}

describe("taste Fitting", () => {
  it("manifest parses as a design-faculty skill fitting with a verify hook", async () => {
    const manifest = await readYamlFile<RawManifest>(path.join(TASTE_DIR, "apm.yml"));
    const metadata = parseGarrisonMetadata(manifest!["x-garrison"]);
    expect(metadata.faculty).toBe("design");
    expect(metadata.component_shape).toBe("skill");
    expect(metadata.verify?.command).toContain("design-taste-frontend");
    expect(metadata.verify?.command).toContain("redesign-existing-projects");
  });

  it("upstream pin is a full commit SHA on the MIT-licensed source repo", () => {
    const pin = JSON.parse(
      readFileSync(path.join(TASTE_DIR, "upstream.json"), "utf8")
    ) as UpstreamPin;
    expect(pin.repo).toBe("https://github.com/Leonxlnx/taste-skill");
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.license).toBe("MIT");
    expect(readFileSync(path.join(TASTE_DIR, "LICENSE"), "utf8")).toContain("MIT License");
  });

  it("vendored skill files match the pinned hashes (no silent drift at rest)", () => {
    const pin = JSON.parse(
      readFileSync(path.join(TASTE_DIR, "upstream.json"), "utf8")
    ) as UpstreamPin;
    const rels = Object.keys(pin.files);
    expect(rels).toContain(".apm/skills/design-taste-frontend/SKILL.md");
    expect(rels).toContain(".apm/skills/redesign-existing-projects/SKILL.md");
    for (const [rel, meta] of Object.entries(pin.files)) {
      const actual = createHash("sha256")
        .update(readFileSync(path.join(TASTE_DIR, rel)))
        .digest("hex");
      expect(actual, `${rel} drifted from the vendored pin`).toBe(meta.sha256);
    }
  });

  it("each vendored skill dir carries the upstream MIT license", () => {
    for (const skill of ["design-taste-frontend", "redesign-existing-projects"]) {
      const license = readFileSync(
        path.join(TASTE_DIR, ".apm", "skills", skill, "LICENSE"),
        "utf8"
      );
      expect(license).toContain("Copyright (c) 2026 Leonxlnx");
    }
  });

  it("is registered in the library with its local path", () => {
    const lib = JSON.parse(
      readFileSync(path.resolve(__dirname, "..", "data", "library.json"), "utf8")
    ) as Array<{ id: string; localPath?: string; platforms?: string[] }>;
    const entry = lib.find((e) => e.id === "taste");
    expect(entry?.localPath).toBe("fittings/seed/taste");
    expect(entry?.platforms).toContain("all");
  });
});
