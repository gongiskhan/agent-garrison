import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { resolveCapabilities } from "@/lib/capabilities";
import type { GarrisonMetadata } from "@/lib/types";
import { readYamlFile } from "@/lib/yaml";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");
// The survivor Fittings after the faculties-as-roles pivot. The operative/PA
// Fittings (souls, coding-subagent, tier-classifier, loop-heartbeat, scheduler,
// documents, projects-index, testing, mcp-gateway, …) were de-listed from
// data/library.json — they carry the dropped capability kinds and no longer
// parse against the shrunk schema. trello-data-source was revived 2026-06-10
// under the memory role (the data-source kind came back with it).
const seedIds = [
  "memory",
  "trello-data-source",
  "http-gateway",
  "slack-channel",
  "web-channel-default",
  "deepgram-voice",
  "artifact-store",
  "dev-env",
  "screen-share-default",
  "outpost-tailscale-host",
  "monitor-default",
  "browser-default",
  "garrison-orchestrator"
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
  it("each survivor manifest parses with its declared provides/consumes", async () => {
    for (const id of seedIds) {
      const metadata = await loadSeed(id);
      expect(metadata.provides).toBeInstanceOf(Array);
      expect(metadata.consumes).toBeInstanceOf(Array);
    }
  });

  it("memory provides memory-store and optionally consumes vault", async () => {
    const metadata = await loadSeed("memory");
    expect(metadata.faculty).toBe("memory");
    expect(metadata.provides).toContainEqual({ kind: "memory-store", name: "garrison-memory" });
    expect(metadata.consumes).toContainEqual({ kind: "vault", cardinality: "optional-one" });
  });

  it("trello-data-source rejoins the memory role with its Trello-backed derived Tasks", async () => {
    const metadata = await loadSeed("trello-data-source");
    expect(metadata.faculty).toBe("memory");
    expect(metadata.component_shape).toBe("cli");
    expect(metadata.provides).toContainEqual({ kind: "data-source", name: "trello" });
    expect(metadata.consumes).toContainEqual({ kind: "vault", cardinality: "one" });
    expect(metadata.tasks).toEqual({ source: "trello", truth_file: "tasks/trello.md" });
  });

  it("web-channel-default folds into the channels role and provides channel:web", async () => {
    const metadata = await loadSeed("web-channel-default");
    expect(metadata.faculty).toBe("channels");
    expect(metadata.own_port).toBe(true);
    expect(metadata.provides).toContainEqual({ kind: "channel", name: "web" });
    expect(metadata.consumes).toContainEqual({ kind: "voice", cardinality: "optional-one" });
  });

  it("deepgram-voice folds into the channels role and provides voice:deepgram", async () => {
    const metadata = await loadSeed("deepgram-voice");
    expect(metadata.faculty).toBe("channels");
    expect(metadata.own_port).toBe(true);
    expect(metadata.provides).toContainEqual({ kind: "voice", name: "deepgram" });
    expect(metadata.consumes).toContainEqual({ kind: "vault", cardinality: "one" });
  });

  it("own-port runtime Fittings fold into roles + carry the own_port flag", async () => {
    for (const id of ["dev-env", "monitor-default", "browser-default"]) {
      const metadata = await loadSeed(id);
      expect(metadata.own_port).toBe(true);
      // browser-default moved sessions -> surfaces in the 2026-06-18 split.
      expect(["sessions", "surfaces", "observability", "channels"]).toContain(metadata.faculty);
    }
  });

  it("dev-env consolidates the dev-work surfaces under sessions on port 7086", async () => {
    const metadata = await loadSeed("dev-env");
    expect(metadata.faculty).toBe("sessions");
    expect(metadata.own_port).toBe(true);
    expect(metadata.default_port).toBe(7086);
    expect(metadata.provides).toEqual([{ kind: "dev-env", name: "dev-env" }]);
    expect(metadata.consumes).toContainEqual({ kind: "outpost", cardinality: "any" });
    expect(metadata.setup?.command).toContain("install-hooks");
  });

  it("garrison-orchestrator provides the orchestrator capability (spawn retired)", async () => {
    const metadata = await loadSeed("garrison-orchestrator");
    expect(metadata.faculty).toBe("orchestrator");
    expect(metadata.component_shape).toBe("system-prompt");
    expect(metadata.provides).toContainEqual({ kind: "orchestrator", name: "garrison-orchestrator" });
    expect(metadata.consumes).toEqual([]); // souls dispatch + mcp-gateway consume removed
    expect(metadata.spawn).toBeUndefined();
  });

  it("the full survivor stack resolves capabilities cleanly", async () => {
    const metadatas = await Promise.all(
      seedIds.map(async (id) => ({ id, metadata: await loadSeed(id) }))
    );
    const result = resolveCapabilities(metadatas);
    if (!result.ok) {
      throw new Error(
        `expected survivor stack to resolve cleanly; got: ${JSON.stringify(result.errors, null, 2)}`
      );
    }
    expect(result.ok).toBe(true);
  });
});
