// S10 seam: materialise-from-service with hash-compared writes (an unchanged
// re-materialise writes ZERO files — dev()'s chokidar watcher depends on it),
// seed-on-first-contact, manifest push CAS, and the enrolled/unenrolled split.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStateService } from "./state-service-harness";
import { resetStateClient } from "../src/lib/state-client";

let h: Awaited<ReturnType<typeof startStateService>>;
let dir: string;

beforeAll(async () => {
  h = await startStateService({ nodes: ["sync-test"] });
  process.env.GARRISON_STATE_URL = h.url;
  process.env.GARRISON_STATE_TOKEN = h.token;
  process.env.GARRISON_NODE_NAME = "sync-test";
  resetStateClient();
  dir = mkdtempSync(path.join(os.tmpdir(), "gar-comp-sync-"));
}, 30_000);

afterAll(async () => {
  delete process.env.GARRISON_STATE_URL;
  delete process.env.GARRISON_STATE_TOKEN;
  delete process.env.GARRISON_NODE_NAME;
  resetStateClient();
  await h?.stop();
});

describe("composition sync", () => {
  it("first contact seeds the service from the local tree", async () => {
    const { syncCompositionFromState } = await import("../src/lib/composition-sync");
    writeFileSync(path.join(dir, "apm.yml"), "name: sync-fixture\n");
    const out = await syncCompositionFromState("sync-fixture", dir);
    expect(out.source).toBe("seeded-to-service");
    const comp = await h.client.getComposition("sync-fixture");
    expect(comp?.manifestYaml).toBe("name: sync-fixture\n");
  });

  it("materialises service changes; an unchanged re-sync writes ZERO files", async () => {
    const { syncCompositionFromState } = await import("../src/lib/composition-sync");
    const comp = await h.client.getComposition("sync-fixture");
    await h.client.putComposition("sync-fixture", "name: sync-fixture\nedited: true\n", {
      ifMatchRev: comp!.rev
    });
    await h.client.putCompositionFile("sync-fixture", ".garrison/routing.json", "{\"v\":2}");

    const first = await syncCompositionFromState("sync-fixture", dir);
    expect(first.source).toBe("service");
    expect(first.refreshedFiles.sort()).toEqual([".garrison/routing.json", "apm.yml"]);
    expect(readFileSync(path.join(dir, "apm.yml"), "utf8")).toContain("edited: true");

    // The zero-write pass: mtimes must not move.
    const before = {
      manifest: statSync(path.join(dir, "apm.yml")).mtimeMs,
      routing: statSync(path.join(dir, ".garrison", "routing.json")).mtimeMs
    };
    const second = await syncCompositionFromState("sync-fixture", dir);
    expect(second.refreshedFiles).toEqual([]);
    expect(statSync(path.join(dir, "apm.yml")).mtimeMs).toBe(before.manifest);
    expect(statSync(path.join(dir, ".garrison", "routing.json")).mtimeMs).toBe(before.routing);
  });

  it("pushManifestToState uses rev CAS", async () => {
    const { pushManifestToState } = await import("../src/lib/composition-sync");
    const out = await pushManifestToState("sync-fixture", "name: sync-fixture\nrev3: true\n");
    expect(out.pushed).toBe(true);
    const comp = await h.client.getComposition("sync-fixture");
    expect(comp?.manifestYaml).toContain("rev3");
  });

  it("materializeEnvViaAuthority renders from the authority for an enrolled node", async () => {
    const { materializeEnvViaAuthority } = await import("../src/lib/composition-sync");
    await h.client.putSecret("SYNC_TEST_KEY", "v1");
    await h.client.putGrant("sync-test", "*");
    const envDir = mkdtempSync(path.join(os.tmpdir(), "gar-env-"));
    const { envPath, source } = await materializeEnvViaAuthority(envDir, "sync-fixture");
    expect(source).toBe("authority");
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("SYNC_TEST_KEY=v1");
    expect((statSync(envPath).mode & 0o777).toString(8)).toBe("600");
  });

  it("an unenrolled process reports unenrolled and touches nothing", async () => {
    const { syncCompositionFromState } = await import("../src/lib/composition-sync");
    const savedUrl = process.env.GARRISON_STATE_URL;
    const savedToken = process.env.GARRISON_STATE_TOKEN;
    const savedHome = process.env.GARRISON_HOME;
    delete process.env.GARRISON_STATE_URL;
    delete process.env.GARRISON_STATE_TOKEN;
    process.env.GARRISON_HOME = mkdtempSync(path.join(os.tmpdir(), "gar-empty-home-"));
    resetStateClient();
    try {
      const out = await syncCompositionFromState("sync-fixture", dir);
      expect(out.source).toBe("unenrolled");
    } finally {
      process.env.GARRISON_STATE_URL = savedUrl;
      process.env.GARRISON_STATE_TOKEN = savedToken;
      if (savedHome === undefined) delete process.env.GARRISON_HOME;
      else process.env.GARRISON_HOME = savedHome;
      resetStateClient();
    }
  });
});
