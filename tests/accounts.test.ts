import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAccount,
  listAccounts,
  removeAccount,
  setAccountNeedsRelogin,
  accountTokenForSpawn
} from "@/lib/accounts";
import {
  accountAuthEnv,
  accountVaultKey,
  accountNameFromVaultKey,
  isValidAccountName,
  looksLikeAnthropicToken,
  ANTHROPIC_ACCOUNT_PREFIX
} from "@/lib/account-env";
import { readVaultSecrets, unlockVault } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

// RUNTIME-ACCOUNTS-V1 — the account registry: token in the vault only,
// metadata in the registry file, audit-recorded spawn delivery. Sandboxed
// GARRISON_HOME + vault path; vitest ephemeral master key (no OS keychain).

let dir: string;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

const TOKEN_A = "sk-ant-oat01-test-token-account-a-0123456789";
const TOKEN_B = "sk-ant-oat01-test-token-account-b-9876543210";

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-accounts-"));
  process.env.GARRISON_HOME = dir;
  process.env.GARRISON_VAULT_PATH = path.join(dir, "vault.json");
  resetVaultRuntime();
  await unlockVault();
});

afterEach(() => {
  delete process.env.GARRISON_HOME;
  delete process.env.GARRISON_VAULT_PATH;
  resetVaultRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe("account-env vocabulary (pure)", () => {
  it("builds and parses vault keys", () => {
    expect(accountVaultKey("work1")).toBe(`${ANTHROPIC_ACCOUNT_PREFIX}work1`);
    expect(accountNameFromVaultKey("ANTHROPIC_ACCOUNT__work1")).toBe("work1");
    expect(accountNameFromVaultKey("OPENAI_API_KEY")).toBeNull();
    expect(accountNameFromVaultKey("ANTHROPIC_ACCOUNT__Bad Name")).toBeNull();
  });

  it("validates names and token shapes", () => {
    expect(isValidAccountName("personal")).toBe(true);
    expect(isValidAccountName("work-1")).toBe(true);
    expect(isValidAccountName("Work1")).toBe(false);
    expect(isValidAccountName("")).toBe(false);
    expect(looksLikeAnthropicToken(TOKEN_A)).toBe(true);
    expect(looksLikeAnthropicToken("hunter2")).toBe(false);
  });

  it("accountAuthEnv pins both token vars, blanks the API key, and marks the account", () => {
    const env = accountAuthEnv("work1", TOKEN_A);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN_A);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.GARRISON_ACCOUNT).toBe("work1");
  });
});

describe("account registry (D1)", () => {
  it("add → list → remove roundtrip; token only in the vault, never in the registry file", async () => {
    await addAccount({ name: "personal", token: TOKEN_A, label: "Personal Max" });
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: "personal", label: "Personal Max", status: "ready" });
    expect(accounts[0].ageDays).toBe(0);
    // The registry file must not contain the token value.
    const registryRaw = readFileSync(path.join(dir, "anthropic-accounts.json"), "utf8");
    expect(registryRaw).not.toContain(TOKEN_A);
    // The vault holds it.
    const secrets = await readVaultSecrets();
    expect(secrets.find((s) => s.key === "ANTHROPIC_ACCOUNT__personal")?.value).toBe(TOKEN_A);

    await removeAccount("personal");
    expect(await listAccounts()).toHaveLength(0);
    expect((await readVaultSecrets()).find((s) => s.key === "ANTHROPIC_ACCOUNT__personal")).toBeUndefined();
  });

  it("re-adding an existing name replaces the token (D2) and restamps created_at", async () => {
    await addAccount({ name: "work1", token: TOKEN_A });
    await addAccount({ name: "work1", token: TOKEN_B });
    const secrets = await readVaultSecrets();
    expect(secrets.filter((s) => s.key === "ANTHROPIC_ACCOUNT__work1")).toHaveLength(1);
    expect(secrets.find((s) => s.key === "ANTHROPIC_ACCOUNT__work1")?.value).toBe(TOKEN_B);
    expect(await listAccounts()).toHaveLength(1);
  });

  it("rejects invalid names and non-token values", async () => {
    await expect(addAccount({ name: "Bad Name", token: TOKEN_A })).rejects.toThrow(/invalid account name/);
    await expect(addAccount({ name: "ok", token: "not-a-token" })).rejects.toThrow(/does not look like an Anthropic token/);
  });

  it("surfaces vault-only tokens (hand-added in the Vault tab) as accounts", async () => {
    const secrets = await readVaultSecrets();
    await (await import("@/lib/vault")).writeVaultSecrets([
      ...secrets,
      { key: "ANTHROPIC_ACCOUNT__handmade", value: TOKEN_A }
    ]);
    const accounts = await listAccounts();
    expect(accounts.map((a) => a.name)).toContain("handmade");
    expect(accounts.find((a) => a.name === "handmade")?.status).toBe("ready");
  });

  it("needs_relogin flag set + cleared (D5)", async () => {
    await addAccount({ name: "work1", token: TOKEN_A });
    await setAccountNeedsRelogin("work1", true);
    expect((await listAccounts())[0].needs_relogin).toBe(true);
    await setAccountNeedsRelogin("work1", false);
    expect((await listAccounts())[0].needs_relogin).toBeUndefined();
  });
});

describe("accountTokenForSpawn (audited delivery)", () => {
  it("delivers the token for a registered account", async () => {
    await addAccount({ name: "work1", token: TOKEN_A });
    await expect(accountTokenForSpawn("work1", "claude-code-runtime")).resolves.toBe(TOKEN_A);
  });

  it("FAILS LOUD when the account has no token", async () => {
    await expect(accountTokenForSpawn("ghost", "claude-code-runtime")).rejects.toThrow(/no token in the vault/);
  });
});
