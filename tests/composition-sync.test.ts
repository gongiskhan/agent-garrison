// S10 seam: materialise-from-service with hash-compared writes (an unchanged
// re-materialise writes ZERO files — dev()'s chokidar watcher depends on it),
// seed-on-first-contact, manifest push CAS, and the enrolled/unenrolled split.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStateService } from "./state-service-harness";
import { resetStateClient } from "../src/lib/state-client";
import type { LibraryEntry } from "../src/lib/types";
import { parse as parseYaml } from "yaml";

let h: Awaited<ReturnType<typeof startStateService>>;
let dir: string;

beforeAll(async () => {
  h = await startStateService({ nodes: ["sync-test", "sync-nogrant"] });
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

// A vault consumer with an explicit secret_scope, the shape capture-service has.
function vaultConsumer(id: string, scope: string[]): LibraryEntry {
  return {
    id,
    name: id,
    faculty: "channels",
    repo: "local",
    summary: "",
    platforms: ["claude-code"],
    ratings: {},
    metadata: {
      faculty: "channels",
      cardinality_hint: "single",
      component_shape: "script",
      platforms: ["claude-code"],
      config_schema: [],
      provides: [{ kind: "voice", name: id }],
      consumes: [{ kind: "vault", cardinality: "one" }],
      verify: { command: "echo ok", expect: "ok", timeout_ms: 1000 },
      secret_scope: scope
    }
  } as unknown as LibraryEntry;
}

describe("composition sync", () => {
  const legacyGatewayManifest = (port = 5777) => `name: legacy-gateway\n# Keep the authored configuration.\nx-garrison:\n  composition:\n    selections:\n      gateway:\n        - id: http-gateway\n          config:\n            port: ${port}\n            stretch_claude_home: false\n            stretch_strategy: continue\n      channels:\n        - id: fixture-channel\n          config:\n            enabled: true\n`;
  it("removes the retired gateway flag from the authority before materialization and stays idempotent", async () => {
    const { syncCompositionFromState } = await import("../src/lib/composition-sync");
    const raw = legacyGatewayManifest();
    await h.client.putComposition("retired-gateway", raw, { ifMatchRev: 0 });
    const target = mkdtempSync(path.join(os.tmpdir(), "gar-retired-gateway-"));
    await syncCompositionFromState("retired-gateway", target);
    const stored = (await h.client.getComposition("retired-gateway"))!;
    const expected = parseYaml(raw);
    delete expected["x-garrison"].composition.selections.gateway[0].config.stretch_claude_home;
    expect(parseYaml(stored.manifestYaml)).toEqual(expected);
    expect(stored.manifestYaml).toContain("# Keep the authored configuration.");
    expect(readFileSync(path.join(target, "apm.yml"), "utf8")).toBe(stored.manifestYaml);
    const mtime = statSync(path.join(target, "apm.yml")).mtimeMs;
    expect((await syncCompositionFromState("retired-gateway", target)).refreshedFiles).toEqual([]);
    expect((await h.client.getComposition("retired-gateway"))!.rev).toBe(stored.rev);
    expect(statSync(path.join(target, "apm.yml")).mtimeMs).toBe(mtime);
  });
  it("preserves a concurrent authority edit when retiring the gateway flag", async () => {
    const { syncCompositionFromState } = await import("../src/lib/composition-sync");
    const { stateClient } = await import("../src/lib/state-client");
    await h.client.putComposition("retired-gateway-cas", legacyGatewayManifest(), { ifMatchRev: 0 });
    const target = mkdtempSync(path.join(os.tmpdir(), "gar-retired-gateway-cas-"));
    const write = vi.spyOn(stateClient(), "putComposition").mockImplementationOnce(async (id) => {
      const current = (await h.client.getComposition(id))!;
      await h.client.putComposition(id, legacyGatewayManifest(5888), { ifMatchRev: current.rev });
      throw Object.assign(new Error("Concurrent edit"), { status: 409 });
    });
    try {
      await syncCompositionFromState("retired-gateway-cas", target);
      const config = parseYaml((await h.client.getComposition("retired-gateway-cas"))!.manifestYaml)["x-garrison"].composition.selections.gateway[0].config;
      expect(config).toEqual({ port: 5888, stretch_strategy: "continue" });
      expect(write).toHaveBeenCalledTimes(2);
    } finally { write.mockRestore(); }
  });
  it("retires the flag before seeding a composition and refreshes the local first-contact manifest", async () => {
    const { syncCompositionFromState } = await import("../src/lib/composition-sync");
    const target = mkdtempSync(path.join(os.tmpdir(), "gar-retired-gateway-seed-"));
    writeFileSync(path.join(target, "apm.yml"), legacyGatewayManifest());
    const result = await syncCompositionFromState("retired-gateway-seed", target);
    expect(result).toEqual({ source: "seeded-to-service", refreshedFiles: ["apm.yml"] });
    const stored = (await h.client.getComposition("retired-gateway-seed"))!;
    expect(stored.manifestYaml).not.toContain("stretch_claude_home");
    expect(readFileSync(path.join(target, "apm.yml"), "utf8")).toBe(stored.manifestYaml);
  });
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

  it("scopedSecretsViaAuthority resolves ONLY the named keys from the authority and names what it lacks", async () => {
    const { scopedSecretsViaAuthority } = await import("../src/lib/composition-sync");
    await h.client.putSecret("SCOPE_PROBE_TOKEN", "probe-token-value");
    await h.client.putSecret("SCOPE_OTHER_KEY", "never-delivered");
    await h.client.putGrant("sync-test", "*");
    const out = await scopedSecretsViaAuthority(["SCOPE_PROBE_TOKEN", "SCOPE_UNSTORED_KEY"]);
    expect(out.source).toBe("authority");
    expect(out.values).toEqual({ SCOPE_PROBE_TOKEN: "probe-token-value" });
    expect(out.missing).toEqual(["SCOPE_UNSTORED_KEY"]);
  });

  it("vaultEnvForEntry on an enrolled node delivers the scoped secrets from the authority, not the empty local vault", async () => {
    // Every mesh peer's local vault is empty by design; before this seam the
    // own-port spawn read it anyway and the voice layer started keyless on
    // every node but the authority. The local vault here does not even exist.
    const { vaultEnvForEntry } = await import("../src/lib/own-port-lifecycle");
    const { readVaultAudit } = await import("../src/lib/vault-audit");
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "gar-scoped-"));
    process.env.GARRISON_VAULT_PATH = path.join(sandbox, "absent-vault.json");
    process.env.GARRISON_VAULT_AUDIT_PATH = path.join(sandbox, "audit.jsonl");
    try {
      const env = await vaultEnvForEntry(vaultConsumer("scoped-probe", ["SCOPE_PROBE_TOKEN", "SCOPE_UNSTORED_KEY"]));
      expect(env).toEqual({ SCOPE_PROBE_TOKEN: "probe-token-value" });
      const last = (await readVaultAudit()).at(-1);
      expect(last).toMatchObject({
        connector: "scoped-probe",
        action: "deliver",
        outcome: "ok",
        secrets: ["SCOPE_PROBE_TOKEN"],
        detail: "authority; missing: SCOPE_UNSTORED_KEY"
      });
    } finally {
      delete process.env.GARRISON_VAULT_PATH;
      delete process.env.GARRISON_VAULT_AUDIT_PATH;
    }
  });

  it("a node the authority has not granted the keys to starts keyless, audited as denied by the authority", async () => {
    const { vaultEnvForEntry } = await import("../src/lib/own-port-lifecycle");
    const { readVaultAudit } = await import("../src/lib/vault-audit");
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "gar-scoped-denied-"));
    process.env.GARRISON_VAULT_AUDIT_PATH = path.join(sandbox, "audit.jsonl");
    process.env.GARRISON_STATE_TOKEN = h.tokens["sync-nogrant"];
    process.env.GARRISON_NODE_NAME = "sync-nogrant";
    resetStateClient();
    try {
      const env = await vaultEnvForEntry(vaultConsumer("denied-probe", ["SCOPE_PROBE_TOKEN"]));
      expect(env).toEqual({});
      const last = (await readVaultAudit()).at(-1);
      expect(last).toMatchObject({
        connector: "denied-probe",
        action: "denied",
        outcome: "denied",
        secrets: ["SCOPE_PROBE_TOKEN"],
        detail: "authority-grant"
      });
    } finally {
      delete process.env.GARRISON_VAULT_AUDIT_PATH;
      process.env.GARRISON_STATE_TOKEN = h.token;
      process.env.GARRISON_NODE_NAME = "sync-test";
      resetStateClient();
    }
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
