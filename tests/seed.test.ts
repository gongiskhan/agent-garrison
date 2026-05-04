import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { resolveCapabilities } from "@/lib/capabilities";
import type { GarrisonMetadata } from "@/lib/types";
import { readYamlFile } from "@/lib/yaml";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");
const seedIds = [
  "loop-heartbeat",
  "tier-classifier",
  "memory",
  "http-gateway",
  "browser-automation",
  "trello-data-source"
] as const;

interface RawManifest {
  "x-garrison"?: unknown;
}

async function loadSeed(id: string): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<RawManifest>(path.join(SEED_DIR, id, "apm.yml"));
  expect(manifest, `seed ${id} should have an apm.yml`).toBeTruthy();
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

describe("seed Fittings", () => {
  it("each seed manifest parses with its declared provides/consumes", async () => {
    for (const id of seedIds) {
      const metadata = await loadSeed(id);
      expect(metadata.provides).toBeInstanceOf(Array);
      expect(metadata.consumes).toBeInstanceOf(Array);
    }
  });

  it("loop-heartbeat provides automation-runner:loop-heartbeat and consumes orchestrator", async () => {
    const metadata = await loadSeed("loop-heartbeat");
    expect(metadata.provides).toContainEqual({
      kind: "automation-runner",
      name: "loop-heartbeat"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "orchestrator",
      cardinality: "one"
    });
  });

  it("memory provides memory-store and optionally consumes vault", async () => {
    const metadata = await loadSeed("memory");
    expect(metadata.provides).toContainEqual({
      kind: "memory-store",
      name: "garrison-memory"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "vault",
      cardinality: "optional-one"
    });
  });

  it("the full seed stack reports the expected orchestrator gap and nothing else", async () => {
    const metadatas = await Promise.all(
      seedIds.map(async (id) => ({ id, metadata: await loadSeed(id) }))
    );
    const result = resolveCapabilities(metadatas);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const missingOrchestrator = result.errors.filter(
        (error) => error.code === "missing-required" && error.kind === "orchestrator"
      );
      expect(missingOrchestrator.map((error) => error.fittingId).sort()).toEqual(
        ["http-gateway", "loop-heartbeat"].sort()
      );
      const otherErrors = result.errors.filter(
        (error) => !(error.code === "missing-required" && error.kind === "orchestrator")
      );
      expect(otherErrors).toEqual([]);
    }
  });
});
