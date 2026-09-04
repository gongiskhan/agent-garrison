// Mesh secrets: the state service on dev-madrid is the authority every node's
// up() renders from; a node's local vault.json is the standalone store. The
// Vault surface used to write only the local file, so a key saved on an
// enrolled node (the ElevenLabs key, saved on dev-madrid after the one-time
// import) reached no node at all. These pin the write-through: values go to the
// authority first and fail loudly when it is unreachable; the surface lists the
// authority's keys; removing a row never deletes from the authority.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyVaultSecretUpdates,
  MESH_HELD_PREVIEW,
  readVaultSecrets,
  unlockVault,
  vaultViewMasked,
  writeVaultSecrets
} from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";
import { resetStateClient } from "@/lib/state-client";

const AUTHORITY = "https://state.test:8860";
let dir: string;
let calls: Array<{ method: string; path: string; body: unknown }>;
let authorityKeys: string[];
let authorityDown: boolean;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: url.pathname, body });
  if (authorityDown) throw new Error("connect ECONNREFUSED");
  if (method === "GET" && url.pathname === "/v1/secrets") {
    return new Response(
      JSON.stringify({ keys: authorityKeys.map((key) => ({ key, updatedAt: "t", updatedBy: "dev-madrid", rev: 1 })) }),
      { status: 200 }
    );
  }
  if (method === "PUT" && url.pathname.startsWith("/v1/secrets/")) {
    const key = decodeURIComponent(url.pathname.slice("/v1/secrets/".length));
    if (!authorityKeys.includes(key)) authorityKeys.push(key);
    return new Response(JSON.stringify({ ok: true, key }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-vault-mesh-"));
  process.env.GARRISON_VAULT_PATH = path.join(dir, "vault.json");
  process.env.GARRISON_VAULT_AUDIT_PATH = path.join(dir, "audit.jsonl");
  process.env.VAULT_UNLOCKED = "true";
  process.env.GARRISON_STATE_URL = AUTHORITY;
  process.env.GARRISON_STATE_TOKEN = "test-token";
  calls = [];
  authorityKeys = ["DEEPGRAM_API_KEY", "CAPTURE_TOKEN"];
  authorityDown = false;
  vi.stubGlobal("fetch", fakeFetch);
  resetStateClient();
  resetVaultRuntime();
  await unlockVault();
  await writeVaultSecrets([{ key: "LOCAL_ONLY", value: "local-value" }]);
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GARRISON_VAULT_PATH;
  delete process.env.GARRISON_VAULT_AUDIT_PATH;
  delete process.env.VAULT_UNLOCKED;
  delete process.env.GARRISON_STATE_URL;
  delete process.env.GARRISON_STATE_TOKEN;
  resetStateClient();
  resetVaultRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe("vault write-through to the mesh authority", () => {
  it("lists the authority's keys beside the local ones, without a value", async () => {
    const view = await vaultViewMasked();
    const byKey = Object.fromEntries(view.secrets.map((s) => [s.key, s]));
    expect(Object.keys(byKey).sort()).toEqual(["CAPTURE_TOKEN", "DEEPGRAM_API_KEY", "LOCAL_ONLY"]);
    expect(byKey.DEEPGRAM_API_KEY).toEqual({ key: "DEEPGRAM_API_KEY", set: true, preview: MESH_HELD_PREVIEW });
    expect(byKey.LOCAL_ONLY.preview).not.toBe(MESH_HELD_PREVIEW);
    expect(JSON.stringify(view)).not.toContain("local-value");
  });

  it("puts every saved value to the authority before the local file", async () => {
    const out = await applyVaultSecretUpdates([
      { key: "LOCAL_ONLY" },
      { key: "DEEPGRAM_API_KEY" },
      { key: "CAPTURE_TOKEN" },
      { key: "ELEVENLABS_API_KEY", value: "el-secret" }
    ]);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toEqual([{ method: "PUT", path: "/v1/secrets/ELEVENLABS_API_KEY", body: { value: "el-secret" } }]);
    expect(authorityKeys).toContain("ELEVENLABS_API_KEY");

    // Round-tripped mesh rows are not invented locally as "".
    const local = await readVaultSecrets();
    expect(local.map((s) => s.key).sort()).toEqual(["ELEVENLABS_API_KEY", "LOCAL_ONLY"]);

    // The answer is the merged list the surface will show next.
    expect(out.map((s) => s.key).sort()).toEqual(["CAPTURE_TOKEN", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "LOCAL_ONLY"]);
  });

  it("removing a row never deletes from the authority", async () => {
    await applyVaultSecretUpdates([{ key: "LOCAL_ONLY" }]);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(authorityKeys).toEqual(["DEEPGRAM_API_KEY", "CAPTURE_TOKEN"]);
    const view = await vaultViewMasked();
    expect(view.secrets.map((s) => s.key)).toContain("CAPTURE_TOKEN");
  });

  it("fails the save loudly when the authority is unreachable, touching nothing locally", async () => {
    authorityDown = true;
    await expect(
      applyVaultSecretUpdates([{ key: "LOCAL_ONLY" }, { key: "NEW_KEY", value: "v" }])
    ).rejects.toThrow(/state service/i);
    const local = await readVaultSecrets();
    expect(local).toEqual([{ key: "LOCAL_ONLY", value: "local-value" }]);
  });
});
