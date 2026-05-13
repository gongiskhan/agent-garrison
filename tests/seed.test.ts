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
  "google-calendar",
  "morning-briefing",
  "scheduler",
  "trello-data-source",
  "slack-channel",
  "soul",
  "personal-operative",
  "artifact-store",
  "documents",
  "projects-index",
  "coding-subagent",
  "terminal-armory-default",
  "screen-share-default",
  "worktree-management-sequoias",
  "session-view-sequoias",
  "mcp-gateway",
  "testing",
  "soul-engineer",
  "soul-architect",
  "soul-assistant",
  "soul-researcher",
  "soul-companion",
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

  it("personal-operative provides the orchestrator capability and consumes soul + composition Faculties", async () => {
    const metadata = await loadSeed("personal-operative");
    expect(metadata.faculty).toBe("orchestrator");
    expect(metadata.component_shape).toBe("system-prompt");
    expect(metadata.provides).toContainEqual({
      kind: "orchestrator",
      name: "personal-operative"
    });
    expect(metadata.consumes).toContainEqual({ kind: "soul", cardinality: "one" });
    expect(metadata.consumes).toContainEqual({ kind: "agent-skill", cardinality: "any" });
    expect(metadata.consumes).toContainEqual({ kind: "channel", cardinality: "any" });
    expect(metadata.consumes).toContainEqual({ kind: "data-source", cardinality: "any" });
  });

  it("google-calendar provides automation-runner:google-calendar and consumes vault + scheduler", async () => {
    const metadata = await loadSeed("google-calendar");
    expect(metadata.faculty).toBe("automations");
    expect(metadata.provides).toContainEqual({
      kind: "automation-runner",
      name: "google-calendar"
    });
    expect(metadata.consumes).toContainEqual({ kind: "vault", cardinality: "one" });
    expect(metadata.consumes).toContainEqual({
      kind: "automation-runner",
      name: "scheduler",
      cardinality: "optional-one"
    });
  });

  it("morning-briefing provides nothing and consumes scheduler+slack required, trello+google-calendar optional", async () => {
    const metadata = await loadSeed("morning-briefing");
    expect(metadata.faculty).toBe("automations");
    expect(metadata.provides).toEqual([]);
    expect(metadata.consumes).toContainEqual({
      kind: "automation-runner",
      name: "scheduler",
      cardinality: "one"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "channel",
      name: "slack",
      cardinality: "one"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "data-source",
      name: "trello",
      cardinality: "optional-one"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "automation-runner",
      name: "google-calendar",
      cardinality: "optional-one"
    });
  });

  it("coding-subagent provides agent-skill:coding-subagent and consumes projects-index + documents + artifact-store", async () => {
    const metadata = await loadSeed("coding-subagent");
    expect(metadata.faculty).toBe("skills");
    expect(metadata.component_shape).toBe("skill");
    expect(metadata.provides).toContainEqual({
      kind: "agent-skill",
      name: "coding-subagent"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "agent-skill",
      name: "projects-index",
      cardinality: "one"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "agent-skill",
      name: "project-documents",
      cardinality: "one"
    });
    expect(metadata.consumes).toContainEqual({
      kind: "artifact-store",
      cardinality: "one"
    });
    expect(metadata.for_consumers).toBeTruthy();
    expect(metadata.for_consumers!).toContain("coding-subagent");
  });

  it("the full seed stack resolves capabilities cleanly", async () => {
    // garrison-orchestrator is an alternative orchestrator — it cannot coexist with
    // personal-operative in the same stack. Exclude it from the combined resolution test.
    const resolutionIds = seedIds.filter((id) => id !== "garrison-orchestrator");
    const metadatas = await Promise.all(
      resolutionIds.map(async (id) => ({ id, metadata: await loadSeed(id) }))
    );
    const result = resolveCapabilities(metadatas);
    if (!result.ok) {
      throw new Error(
        `expected seed stack to resolve cleanly; got: ${JSON.stringify(result.errors, null, 2)}`
      );
    }
    expect(result.ok).toBe(true);
  });

  it("soul fittings parse correctly with spawn configs", async () => {
    const souls = [
      { id: "soul-engineer",    soulName: "engineer"    },
      { id: "soul-architect",   soulName: "architect"   },
      { id: "soul-assistant",   soulName: "assistant"   },
      { id: "soul-researcher",  soulName: "researcher"  },
      { id: "soul-companion",   soulName: "companion"   }
    ];
    for (const { id, soulName } of souls) {
      const metadata = await loadSeed(id);
      expect(metadata.faculty).toBe("skills");
      expect(metadata.component_shape).toBe("system-prompt");
      expect(metadata.provides).toContainEqual({ kind: "agent-skill", name: `soul.${soulName}` });
      expect(metadata.spawn).toBeDefined();
      expect(["claude_code", "none"]).toContain(metadata.spawn!.preset);
    }
  });

  it("garrison-orchestrator provides orchestrator capability with spawn=none", async () => {
    const metadata = await loadSeed("garrison-orchestrator");
    expect(metadata.faculty).toBe("orchestrator");
    expect(metadata.component_shape).toBe("system-prompt");
    expect(metadata.provides).toContainEqual({ kind: "orchestrator", name: "garrison-orchestrator" });
    expect(metadata.spawn).toBeDefined();
    expect(metadata.spawn!.preset).toBe("none");
    expect(metadata.spawn!.allowed_tools).toEqual([]);
    expect(metadata.spawn!.mcp).toContain("garrison-control");
  });
});
