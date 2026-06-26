import crypto from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  unlockVault,
  vaultStatus,
  vaultView,
  readVaultSecrets,
  writeVaultSecrets
} from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

// A1 — the vault is sealed with a keychain master key (NO passphrase) and writes
// atomically. These tests sandbox GARRISON_VAULT_PATH to a tmp file and rely on
// the vitest ephemeral master key (VITEST is set), so they never touch the real
// OS keychain or the real data/vault.json.

let dir: string;
let vaultPath: string;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-vault-"));
  vaultPath = path.join(dir, "vault.json");
  process.env.GARRISON_VAULT_PATH = vaultPath;
  resetVaultRuntime();
});

afterEach(() => {
  delete process.env.GARRISON_VAULT_PATH;
  resetVaultRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe("vault keychain seal (A1)", () => {
  it("unlocks with NO passphrase and seals the file in keychain (hkdf) format", async () => {
    const result = await unlockVault();
    expect(result.unlocked).toBe(true);
    expect(result.needsPassword).toBe(false);
    const file = JSON.parse(readFileSync(vaultPath, "utf8"));
    expect(file.kdf).toBe("hkdf-sha256");
    expect(file.version).toBe(1);
    expect(typeof file.ciphertext).toBe("string");
  });

  it("round-trips secrets through write/read", async () => {
    await unlockVault();
    const written = await writeVaultSecrets([
      { key: "SLACK_TOKEN", value: "xoxb-123" },
      { key: "GOOGLE_KEY", value: "g-secret-456" }
    ]);
    expect(written).toContainEqual({ key: "SLACK_TOKEN", value: "xoxb-123" });
    const read = await readVaultSecrets();
    expect(read).toContainEqual({ key: "GOOGLE_KEY", value: "g-secret-456" });
    expect(vaultStatus().unlocked).toBe(true);
  });

  it("never writes a secret value in plaintext on disk (sealed at rest)", async () => {
    await unlockVault();
    await writeVaultSecrets([{ key: "STRIPE_KEY", value: "sk_live_supersecret_value" }]);
    const onDisk = readFileSync(vaultPath, "utf8");
    expect(onDisk).not.toContain("sk_live_supersecret_value");
    expect(onDisk).not.toContain("STRIPE_KEY");
  });

  it("writes the vault file with 0600 permissions", async () => {
    await unlockVault();
    await writeVaultSecrets([{ key: "A", value: "1" }]);
    const mode = statSync(vaultPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reports the key source via vaultView (test-ephemeral under vitest)", async () => {
    const view = await vaultView();
    expect(view.keySource).toBe("test-ephemeral");
    expect(view.needsPassword).toBe(false);
  });

  it("migrates a legacy scrypt (dev-passphrase) vault to the keychain seal", async () => {
    // Replicate the retired scrypt+passphrase format on disk.
    const LEGACY = "__GARRISON_DEV_UNLOCK__";
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(LEGACY, salt, 32, { N: 16384, r: 8, p: 1 });
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = JSON.stringify({
      secrets: { LEGACY_TOKEN: "legacy-value-789" },
      updatedAt: new Date(0).toISOString()
    });
    const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    const legacyFile = {
      version: 1,
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    writeFileSync(vaultPath, JSON.stringify(legacyFile, null, 2), { mode: 0o600 });

    const result = await unlockVault();
    expect(result.secrets).toContainEqual({ key: "LEGACY_TOKEN", value: "legacy-value-789" });
    // Re-sealed under the keychain key — the on-disk format is now hkdf.
    const migrated = JSON.parse(readFileSync(vaultPath, "utf8"));
    expect(migrated.kdf).toBe("hkdf-sha256");
  });

  it("reports locked when reading without unlock and without VAULT_UNLOCKED", async () => {
    // Create a sealed vault, then drop the in-process state to simulate a fresh
    // process that has not unlocked and has no auto-unlock gate.
    await unlockVault();
    await writeVaultSecrets([{ key: "X", value: "y" }]);
    resetVaultRuntime();
    const hadGate = process.env.VAULT_UNLOCKED;
    delete process.env.VAULT_UNLOCKED;
    try {
      await expect(readVaultSecrets()).rejects.toThrow(/locked/i);
    } finally {
      if (hadGate !== undefined) process.env.VAULT_UNLOCKED = hadGate;
    }
  });
});
