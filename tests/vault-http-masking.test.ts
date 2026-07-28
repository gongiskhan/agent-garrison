// Regression: no HTTP response may carry a vault secret's plaintext.
//
// GET /api/vault/secrets returned vaultView() verbatim - every key with its
// cleartext value, no auth. Garrison is fronted by `tailscale serve`, which
// proxies to 127.0.0.1, so those requests arrive looking local and a
// remote-address check cannot distinguish them. Verified before the fix by
// curling https://dev-madrid.tail31efa.ts.net/api/vault/secrets from a second
// machine: HTTP 200, all three ANTHROPIC_ACCOUNT__* tokens in the clear.
// POST /api/vault/unlock leaked the same list through a second path.
//
// The dangerous half of the fix is the WRITE path: once the UI only ever holds
// masks, a whole-array PUT would write each row's preview string over the real
// secret. Hence partial updates - a row with no `value` preserves what is stored.

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyVaultSecretUpdates,
  maskSecretValue,
  maskSecrets,
  readVaultSecrets,
  revealVaultSecret,
  unlockVault,
  vaultViewMasked,
  writeVaultSecrets
} from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

const TOKEN = "sk-ant-oat01-not-a-real-token-abcdef0123456789";
const SHORT = "hunter2";

let dir: string;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-vault-mask-"));
  process.env.GARRISON_VAULT_PATH = path.join(dir, "vault.json");
  process.env.GARRISON_VAULT_AUDIT_PATH = path.join(dir, "audit.jsonl");
  process.env.VAULT_UNLOCKED = "true";
  resetVaultRuntime();
  await unlockVault();
  await writeVaultSecrets([
    { key: "ANTHROPIC_ACCOUNT__temp-a", value: TOKEN },
    { key: "SHORT_SECRET", value: SHORT },
    { key: "EMPTY_SECRET", value: "" }
  ]);
});

afterEach(() => {
  delete process.env.GARRISON_VAULT_PATH;
  delete process.env.GARRISON_VAULT_AUDIT_PATH;
  delete process.env.VAULT_UNLOCKED;
  resetVaultRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe("masked vault wire shape", () => {
  it("vaultViewMasked carries no plaintext anywhere in the payload", async () => {
    const view = await vaultViewMasked();
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(SHORT);
    // Names and presence still travel - the UI needs them.
    expect(view.secrets.map((s) => s.key)).toEqual([
      "ANTHROPIC_ACCOUNT__temp-a",
      "EMPTY_SECRET",
      "SHORT_SECRET"
    ]);
    expect(view.secrets.find((s) => s.key === "ANTHROPIC_ACCOUNT__temp-a")?.set).toBe(true);
    expect(view.secrets.find((s) => s.key === "EMPTY_SECRET")?.set).toBe(false);
  });

  it("a short value leaks nothing but its length", () => {
    // head+tail of a short secret IS the secret, so it must not be shown.
    const masked = maskSecretValue(SHORT);
    expect(masked).not.toContain(SHORT);
    expect(masked).not.toContain(SHORT.slice(0, 4));
    expect(masked).toContain(String(SHORT.length));
  });

  it("a long value shows at most 8 characters", () => {
    const masked = maskSecretValue(TOKEN);
    expect(masked).not.toContain(TOKEN);
    const shown = masked.replace(/\(\d+ chars\)/, "").replace(/[…\s]/g, "");
    expect(shown.length).toBeLessThanOrEqual(8);
  });

  it("maskSecrets never emits a `value` field at all", () => {
    const masked = maskSecrets([{ key: "K", value: TOKEN }]);
    expect(Object.keys(masked[0]).sort()).toEqual(["key", "preview", "set"]);
  });
});

describe("partial updates (the mask round-trip)", () => {
  it("an entry with NO value preserves the stored secret", async () => {
    // Exactly what the UI sends for an untouched row. Before partial updates
    // this path wrote the mask over the credential.
    await applyVaultSecretUpdates([
      { key: "ANTHROPIC_ACCOUNT__temp-a" },
      { key: "SHORT_SECRET" },
      { key: "EMPTY_SECRET" }
    ]);

    const stored = await readVaultSecrets();
    expect(stored.find((s) => s.key === "ANTHROPIC_ACCOUNT__temp-a")?.value).toBe(TOKEN);
    expect(stored.find((s) => s.key === "SHORT_SECRET")?.value).toBe(SHORT);
  });

  it("adding a new secret leaves every existing value intact", async () => {
    await applyVaultSecretUpdates([
      { key: "ANTHROPIC_ACCOUNT__temp-a" },
      { key: "SHORT_SECRET" },
      { key: "EMPTY_SECRET" },
      { key: "NEW_ONE", value: "brand-new" }
    ]);

    const stored = await readVaultSecrets();
    expect(stored.find((s) => s.key === "ANTHROPIC_ACCOUNT__temp-a")?.value).toBe(TOKEN);
    expect(stored.find((s) => s.key === "NEW_ONE")?.value).toBe("brand-new");
  });

  it("an entry WITH a value overwrites, including to empty string", async () => {
    await applyVaultSecretUpdates([
      { key: "ANTHROPIC_ACCOUNT__temp-a", value: "rotated" },
      { key: "SHORT_SECRET", value: "" }
    ]);

    const stored = await readVaultSecrets();
    expect(stored.find((s) => s.key === "ANTHROPIC_ACCOUNT__temp-a")?.value).toBe("rotated");
    expect(stored.find((s) => s.key === "SHORT_SECRET")?.value).toBe("");
  });

  it("a key omitted from the list is still deleted", async () => {
    // The list stays authoritative about WHICH secrets exist, exactly as the
    // old whole-array PUT was - otherwise the UI could never remove a row.
    await applyVaultSecretUpdates([{ key: "ANTHROPIC_ACCOUNT__temp-a" }]);

    const stored = await readVaultSecrets();
    expect(stored.map((s) => s.key)).toEqual(["ANTHROPIC_ACCOUNT__temp-a"]);
    expect(stored[0].value).toBe(TOKEN);
  });

  it("returns masked rows, not plaintext", async () => {
    const returned = await applyVaultSecretUpdates([{ key: "ANTHROPIC_ACCOUNT__temp-a" }]);
    expect(JSON.stringify(returned)).not.toContain(TOKEN);
  });
});

describe("explicit reveal", () => {
  it("returns one named plaintext and records it in the audit log", async () => {
    const value = await revealVaultSecret("ANTHROPIC_ACCOUNT__temp-a");
    expect(value).toBe(TOKEN);

    const audit = await readFile(process.env.GARRISON_VAULT_AUDIT_PATH!, "utf8");
    const entries = audit.trim().split("\n").map((line) => JSON.parse(line));
    const reveal = entries.find(
      (e) => e.connector === "ui:vault" && e.secrets.includes("ANTHROPIC_ACCOUNT__temp-a")
    );
    expect(reveal).toBeTruthy();
    expect(reveal.outcome).toBe("ok");
    // The audit log records the ACT, never the value.
    expect(audit).not.toContain(TOKEN);
  });

  it("returns null for an unknown key and records the denial", async () => {
    expect(await revealVaultSecret("NOPE")).toBeNull();

    const audit = await readFile(process.env.GARRISON_VAULT_AUDIT_PATH!, "utf8");
    const denied = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((e) => e.secrets.includes("NOPE"));
    expect(denied.outcome).toBe("denied");
  });
});
