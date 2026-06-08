import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { resolveCapabilities } from "@/lib/capabilities";
import type { GarrisonMetadata } from "@/lib/types";
import { readYamlFile } from "@/lib/yaml";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");
// The 14 survivor Fittings after the faculties-as-roles pivot. The operative/PA
// Fittings (souls, coding-subagent, tier-classifier, loop-heartbeat, scheduler,
// trello-data-source, documents, projects-index, testing, mcp-gateway, …) were
// de-listed from data/library.json — they carry the dropped capability kinds and
// no longer parse against the shrunk schema.
const seedIds = [
  "memory",
  "http-gateway",
  "slack-channel",
  "web-channel-default",
  "deepgram-voice",
  "artifact-store",
  "terminal-armory-default",
  "screen-share-default",
  "worktree-management-sequoias",
  "session-view-sequoias",
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
    for (const id of ["terminal-armory-default", "session-view-sequoias", "monitor-default", "browser-default"]) {
      const metadata = await loadSeed(id);
      expect(metadata.own_port).toBe(true);
      expect(["sessions", "observability", "channels"]).toContain(metadata.faculty);
    }
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
