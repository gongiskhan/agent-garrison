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
  "basic-memory",
  "trello",
  "google",
  "http-gateway",
  "slack-channel",
  "web-channel-default",
  "deepgram-voice",
  "dev-env",
  "screen-share-default",
  "outpost-tailscale-host",
  "monitor-default",
  "browser-default",
  "file-browser",
  "garrison-orchestrator",
  "taste",
  "opencode-runtime"
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

  it("basic-memory provides memory-store and optionally consumes vault", async () => {
    const metadata = await loadSeed("basic-memory");
    expect(metadata.faculty).toBe("memory");
    expect(metadata.provides).toContainEqual({ kind: "memory-store", name: "basic-memory" });
    expect(metadata.consumes).toContainEqual({ kind: "vault", cardinality: "optional-one" });
  });

  it("trello is a Vault-sealed connector with an action catalog and no derived-tasks wiring", async () => {
    const metadata = await loadSeed("trello");
    expect(metadata.faculty).toBe("connectors");
    expect(metadata.component_shape).toBe("cli");
    expect(metadata.provides).toContainEqual({ kind: "connector", name: "trello" });
    expect(metadata.consumes).toContainEqual({ kind: "vault", cardinality: "one" });
    expect(metadata.connector?.auth).toBe("api_key");
    expect(metadata.connector?.actions.map((a) => a.name)).toContain("create_card");
    expect(metadata.secret_scope).toContain("TRELLO_KEY");
    // Derived Tasks disconnected (F4) — the connector no longer declares tasks.
    expect(metadata.tasks).toBeUndefined();
  });

  it("google is an oauth2 connector declaring its provider endpoints + client-secret scope", async () => {
    const metadata = await loadSeed("google");
    expect(metadata.faculty).toBe("connectors");
    expect(metadata.connector?.auth).toBe("oauth2");
    expect(metadata.connector?.oauth?.authUrl).toContain("accounts.google.com");
    expect(metadata.connector?.oauth?.tokenUrl).toContain("oauth2.googleapis.com");
    expect(metadata.connector?.oauth?.clientIdSecret).toBe("GOOGLE_OAUTH_CLIENT_ID");
    expect(metadata.connector?.oauth?.scopes.length).toBeGreaterThan(0);
    expect(metadata.secret_scope).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
  });

  it("web-channel-default folds into the channels role and provides channel:web", async () => {
    const metadata = await loadSeed("web-channel-default");
    expect(metadata.faculty).toBe("channels");
    expect(metadata.own_port).toBe(true);
    expect(metadata.provides).toContainEqual({ kind: "channel", name: "web" });
    expect(metadata.consumes).toContainEqual({ kind: "voice", cardinality: "optional-one" });
  });

  it("deepgram is a dual connector — connectors role, provides voice + connector", async () => {
    const metadata = await loadSeed("deepgram-voice");
    expect(metadata.faculty).toBe("connectors");
    expect(metadata.own_port).toBe(true);
    expect(metadata.provides).toContainEqual({ kind: "voice", name: "deepgram" });
    expect(metadata.provides).toContainEqual({ kind: "connector", name: "deepgram" });
    expect(metadata.connector?.actions.map((a) => a.name)).toContain("transcribe");
    expect(metadata.secret_scope).toContain("DEEPGRAM_API_KEY");
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
    expect(metadata.setup?.[0]?.command).toContain("install-hooks");
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
