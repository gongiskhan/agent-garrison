import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAccount,
  listAccounts,
  removeAccount,
  setAccountNeedsRelogin,
  accountTokenForSpawn,
  resolvePrimaryRuntimeAccount,
  resolveRuntimeAccountEnv
} from "@/lib/accounts";
import {
  accountAuthEnv,
  accountVaultKey,
  accountNameFromVaultKey,
  parseAccountVaultKey,
  isValidAccountName,
  looksLikeAnthropicToken,
  ANTHROPIC_ACCOUNT_PREFIX
} from "@/lib/account-env";
import { readVaultSecrets, writeVaultSecrets, unlockVault } from "@/lib/vault";
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
    const registryRaw = readFileSync(path.join(dir, "accounts.json"), "utf8");
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

describe("generic platforms (RUNTIME-ACCOUNTS-V2)", () => {
  it("adds an OpenAI account under a platform-namespaced vault key", async () => {
    await addAccount({ name: "codex1", token: "sk-openai-abc", platform: "openai" });
    const key = accountVaultKey("codex1", "openai");
    expect(key).toBe("ACCOUNT__OPENAI__codex1");
    expect(parseAccountVaultKey(key)).toEqual({ name: "codex1", platform: "openai" });
    const secrets = await readVaultSecrets();
    expect(secrets.find((s) => s.key === key)?.value).toBe("sk-openai-abc");
    const account = (await listAccounts()).find((a) => a.name === "codex1");
    expect(account?.platform).toBe("openai");
    expect(account?.status).toBe("ready");
  });

  it("accountAuthEnv maps each platform to its env vars", () => {
    expect(accountAuthEnv("a", "tok", "anthropic")).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: ""
    });
    expect(accountAuthEnv("b", "tok", "openai")).toMatchObject({ OPENAI_API_KEY: "tok" });
    expect(accountAuthEnv("c", "tok", "google")).toMatchObject({ GEMINI_API_KEY: "tok" });
    expect(accountAuthEnv("glm-box", "tok", "glm")).toMatchObject({
      GLM_API_KEY: "tok",
      GARRISON_ACCOUNT: "glm-box"
    });
    expect(accountAuthEnv("d", "tok", "custom", ["MISTRAL_API_KEY", "MY_TOKEN"])).toMatchObject({
      MISTRAL_API_KEY: "tok",
      MY_TOKEN: "tok"
    });
  });

  it("custom accounts require at least one valid env var name", async () => {
    await expect(addAccount({ name: "x", token: "t", platform: "custom" })).rejects.toThrow(/env var/);
    await expect(
      addAccount({ name: "x", token: "t", platform: "custom", env_keys: ["1BAD NAME"] })
    ).rejects.toThrow(/invalid env var/);
    await addAccount({ name: "mistral", token: "t", platform: "custom", env_keys: ["MISTRAL_API_KEY"] });
    expect((await listAccounts()).find((a) => a.name === "mistral")?.env_keys).toEqual(["MISTRAL_API_KEY"]);
  });

  it("resolveRuntimeAccountEnv injects a provider-matched account without a primary marker", async () => {
    await addAccount({ name: "acc-openai", token: "sk-openai-xyz", platform: "openai" });
    const env = await resolveRuntimeAccountEnv([
      {
        id: "codex-runtime",
        account: "acc-openai",
        expectedPlatform: "openai",
        allowAuthFile: true
      }
    ]);
    expect(env.OPENAI_API_KEY).toBe("sk-openai-xyz");
    expect(env.GARRISON_ACCOUNT).toBeUndefined();
  });

  it("fails loudly on secondary platform mismatches and missing selected accounts", async () => {
    await addAccount({ name: "openai-key", token: "sk-openai-xyz", platform: "openai" });
    await expect(
      resolveRuntimeAccountEnv([
        { id: "gemini-runtime", account: "openai-key", expectedPlatform: "google" }
      ])
    ).rejects.toThrow(/expects a google account.*is openai/);
    await expect(
      resolveRuntimeAccountEnv([
        { id: "codex-runtime", account: "missing", expectedPlatform: "openai" }
      ])
    ).rejects.toThrow(/not in the account registry/);
  });

  it("rejects process-wide secondary collisions instead of choosing the last account", async () => {
    await addAccount({ name: "openai-a", token: "sk-a", platform: "openai" });
    await addAccount({ name: "openai-b", token: "sk-b", platform: "openai" });
    await expect(
      resolveRuntimeAccountEnv([
        { id: "codex-a", account: "openai-a", expectedPlatform: "openai" },
        { id: "codex-b", account: "openai-b", expectedPlatform: "openai" }
      ])
    ).rejects.toThrow(/openai-a.*already owns.*credential rail/);
  });

  it("rejects two secondary accounts on one platform even when their token values match", async () => {
    await addAccount({ name: "openai-same-a", token: "sk-same", platform: "openai" });
    await addAccount({ name: "openai-same-b", token: "sk-same", platform: "openai" });
    await expect(
      resolveRuntimeAccountEnv([
        { id: "codex-a", account: "openai-same-a", expectedPlatform: "openai" },
        { id: "codex-b", account: "openai-same-b", expectedPlatform: "openai" }
      ])
    ).rejects.toThrow(/openai-same-a.*already owns.*credential rail/);
  });

  it("allows two secondary runtimes to reuse the same account on one platform", async () => {
    await addAccount({ name: "openai-shared", token: "sk-shared", platform: "openai" });
    const env = await resolveRuntimeAccountEnv([
      { id: "codex-a", account: "openai-shared", expectedPlatform: "openai" },
      { id: "codex-b", account: "openai-shared", expectedPlatform: "openai" }
    ]);
    expect(env.OPENAI_API_KEY).toBe("sk-shared");
  });

  it("allows a secondary to reuse the exact named account already owned by the primary", async () => {
    await addAccount({ name: "openai-primary", token: "sk-primary", platform: "openai" });
    const env = await resolveRuntimeAccountEnv(
      [{ id: "codex-secondary", account: "openai-primary", expectedPlatform: "openai" }],
      {
        reservedEnv: { OPENAI_API_KEY: "sk-primary" },
        reservedPlatforms: [{
          platform: "openai",
          account: "openai-primary",
          owner: "primary runtime codex-runtime"
        }]
      }
    );
    expect(env.OPENAI_API_KEY).toBe("sk-primary");
  });

  it("rejects a different secondary account on a named primary platform rail", async () => {
    await addAccount({ name: "openai-primary", token: "sk-primary", platform: "openai" });
    await addAccount({ name: "openai-other", token: "sk-primary", platform: "openai" });
    await expect(
      resolveRuntimeAccountEnv(
        [{ id: "codex-secondary", account: "openai-other", expectedPlatform: "openai" }],
        {
          reservedEnv: { OPENAI_API_KEY: "sk-primary" },
          reservedPlatforms: [{
            platform: "openai",
            account: "openai-primary",
            owner: "primary runtime codex-runtime"
          }]
        }
      )
    ).rejects.toThrow(/primary runtime codex-runtime.*credential rail/);
  });

  it("rejects identical-value env collisions owned by different account platforms", async () => {
    await addAccount({ name: "openai-owner", token: "same-secret", platform: "openai" });
    await addAccount({
      name: "custom-owner",
      token: "same-secret",
      platform: "custom",
      env_keys: ["OPENAI_API_KEY"]
    });
    await expect(
      resolveRuntimeAccountEnv([
        { id: "codex-secondary", account: "openai-owner", expectedPlatform: "openai" },
        { id: "custom-secondary", account: "custom-owner", expectedPlatform: "custom" }
      ])
    ).rejects.toThrow(/conflicts on OPENAI_API_KEY/);
  });

  it("rejects a secondary pin on the primary's process-wide platform rail", async () => {
    await addAccount({ name: "openai-a", token: "sk-a", platform: "openai" });
    await expect(
      resolveRuntimeAccountEnv(
        [{ id: "codex-secondary", account: "openai-a", expectedPlatform: "openai" }],
        {
          reservedPlatforms: [
            { platform: "openai", owner: "primary runtime openai-agents-runtime" }
          ]
        }
      )
    ).rejects.toThrow(/primary runtime openai-agents-runtime.*Per-runtime env isolation/);
  });

  it("strictly resolves a named GLM primary into GLM_API_KEY", async () => {
    await addAccount({ name: "glm-box", token: "glm-secret", platform: "glm" });

    const resolved = await resolvePrimaryRuntimeAccount(
      "glm-box",
      "openai-agents-runtime",
      "glm"
    );

    expect(resolved).toMatchObject({
      name: "glm-box",
      platform: "glm",
      credentialKind: "token"
    });
    expect(resolved.env).toMatchObject({
      GLM_API_KEY: "glm-secret",
      GARRISON_ACCOUNT: "glm-box"
    });
    expect(resolved.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("preserves the provider platform when flagging a vault-only account", async () => {
    const secrets = await readVaultSecrets();
    await writeVaultSecrets([
      ...secrets,
      { key: "ACCOUNT__GLM__handmade", value: "glm-secret" }
    ]);

    await setAccountNeedsRelogin("handmade", true, "glm");

    expect((await listAccounts()).find((account) => account.name === "handmade")).toMatchObject({
      platform: "glm",
      needs_relogin: true
    });
  });

  it("fails loudly for a missing or wrong-platform named primary account", async () => {
    await expect(
      resolvePrimaryRuntimeAccount("missing", "openai-agents-runtime", "glm")
    ).rejects.toThrow(/not in the account registry/);

    await addAccount({ name: "openai-key", token: "sk-openai-xyz", platform: "openai" });
    await expect(
      resolvePrimaryRuntimeAccount("openai-key", "openai-agents-runtime", "glm")
    ).rejects.toThrow(/expects a glm account.*is openai/);
  });

  it("REFUSES to reuse a name on another platform, instead of destroying it", async () => {
    // Regression (observed live 2026-07-25): account names are global, so adding
    // a Hugging Face key named "a" silently deleted an OpenRouter account of the
    // same name - registry row AND vault token. Losing a credential must never
    // be a side effect of naming a new one.
    await addAccount({ name: "shift", token: TOKEN_A }); // anthropic
    await expect(
      addAccount({ name: "shift", token: "sk-openai-1", platform: "openai" })
    ).rejects.toThrow(/already exists on Claude \/ Anthropic/);

    const secrets = await readVaultSecrets();
    expect(secrets.some((s) => s.key === "ANTHROPIC_ACCOUNT__shift")).toBe(true);
    expect(secrets.some((s) => s.key === "ACCOUNT__OPENAI__shift")).toBe(false);
    // The original account is intact, not half-migrated.
    const account = (await listAccounts()).find((a) => a.name === "shift");
    expect(account?.platform).toBe("anthropic");
  });

  it("protects a vault-only account of the same name too", async () => {
    // No registry row, just a token someone added in the Vault tab.
    const secrets = await readVaultSecrets();
    await writeVaultSecrets([...secrets, { key: "ACCOUNT__OPENROUTER__solo", value: "sk-or-v1-x" }]);
    await expect(addAccount({ name: "solo", token: TOKEN_A })).rejects.toThrow(
      /already exists on OpenRouter/
    );
    expect((await readVaultSecrets()).some((s) => s.key === "ACCOUNT__OPENROUTER__solo")).toBe(true);
  });

  it("supports migration the explicit way: remove, then add", async () => {
    await addAccount({ name: "shift", token: TOKEN_A });
    await removeAccount("shift");
    await addAccount({ name: "shift", token: "sk-openai-1", platform: "openai" });
    const secrets = await readVaultSecrets();
    expect(secrets.some((s) => s.key === "ANTHROPIC_ACCOUNT__shift")).toBe(false);
    expect(secrets.some((s) => s.key === "ACCOUNT__OPENAI__shift")).toBe(true);
    await removeAccount("shift");
    expect(
      (await readVaultSecrets()).some((s) => parseAccountVaultKey(s.key)?.name === "shift")
    ).toBe(false);
  });

  it("still replaces the credential for the SAME name and platform", async () => {
    await addAccount({ name: "same", token: TOKEN_A });
    await addAccount({ name: "same", token: TOKEN_B });
    const secrets = await readVaultSecrets();
    expect(secrets.find((s) => s.key === "ANTHROPIC_ACCOUNT__same")?.value).toBe(TOKEN_B);
    expect(secrets.filter((s) => parseAccountVaultKey(s.key)?.name === "same")).toHaveLength(1);
  });
});
