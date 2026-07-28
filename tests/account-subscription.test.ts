import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAccount,
  listAccounts,
  removeAccount,
  accountHomeDir,
  materializeAccountHome,
  resolveRuntimeAccountEnv
} from "@/lib/accounts";
import { parseAuthFile, credentialKindsFor, accountVaultKey } from "@/lib/account-env";
import { readVaultSecrets, unlockVault } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

// RUNTIME-ACCOUNTS-V3 — subscription (auth-file) accounts for Codex + Gemini.
// A subscription credential is a FILE the CLI owns and refreshes in place, so
// the invariants differ from an API key: it is materialized into a per-account
// config home, injected as CODEX_HOME / GEMINI_CLI_HOME rather than as a token,
// and must NOT be overwritten from the vault on a routine launch.

let dir: string;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

// Shaped like the real files (verified against codex-cli 0.144.5 / gemini 0.49).
const CODEX_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "id", access_token: "at", refresh_token: "rt", account_id: "acc" },
  last_refresh: "2026-07-25T00:00:00Z"
});
const GEMINI_CREDS = JSON.stringify({
  access_token: "at",
  refresh_token: "rt",
  token_type: "Bearer",
  expiry_date: 1_800_000_000_000
});

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-subscription-"));
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

describe("auth-file validation (pure)", () => {
  it("offers the subscription shape only where the CLI has one", () => {
    expect(credentialKindsFor("openai")).toContain("auth-file");
    expect(credentialKindsFor("google")).toContain("auth-file");
    expect(credentialKindsFor("anthropic")).toEqual(["token"]);
    expect(credentialKindsFor("custom")).toEqual(["token"]);
  });

  it("rejects a pasted API key, truncated JSON, or a file with no refresh material", () => {
    expect(parseAuthFile("openai", "sk-proj-not-a-file").ok).toBe(false);
    expect(parseAuthFile("openai", '{"tokens":{').ok).toBe(false);
    expect(parseAuthFile("openai", '{"tokens":{"access_token":"at"}}').ok).toBe(false);
    expect(parseAuthFile("openai", CODEX_AUTH).ok).toBe(true);
    expect(parseAuthFile("google", GEMINI_CREDS).ok).toBe(true);
  });
});

describe("subscription accounts", () => {
  it("seals the whole credential file and reports the kind", async () => {
    await addAccount({
      name: "work",
      token: CODEX_AUTH,
      platform: "openai",
      credential_kind: "auth-file"
    });
    const account = (await listAccounts()).find((a) => a.name === "work");
    expect(account?.credential_kind).toBe("auth-file");
    expect(account?.platform).toBe("openai");
    const sealed = (await readVaultSecrets()).find(
      (s) => s.key === accountVaultKey("work", "openai")
    );
    expect(JSON.parse(sealed!.value).tokens.refresh_token).toBe("rt");
  });

  it("refuses a credential file for a platform that has none", async () => {
    await expect(
      addAccount({ name: "x", token: CODEX_AUTH, platform: "anthropic", credential_kind: "auth-file" })
    ).rejects.toThrow(/no subscription-credential file/);
  });

  it("materializes a private config home, 0600, with the CLI's companion files", async () => {
    const home = await materializeAccountHome("work", "openai", CODEX_AUTH);
    expect(home).toBe(accountHomeDir("work", "openai"));
    const file = path.join(home, "auth.json");
    expect(JSON.parse(readFileSync(file, "utf8")).auth_mode).toBe("chatgpt");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Gemini refuses to start on creds alone - the auth-type selector must be there.
    const gHome = await materializeAccountHome("g1", "google", GEMINI_CREDS);
    const settings = JSON.parse(readFileSync(path.join(gHome, ".gemini/settings.json"), "utf8"));
    expect(settings.security.auth.selectedType).toBe("oauth-personal");
    expect(existsSync(path.join(gHome, ".gemini/oauth_creds.json"))).toBe(true);
  });

  it("does NOT clobber a credential the CLI refreshed in place", async () => {
    const home = await materializeAccountHome("work", "openai", CODEX_AUTH);
    const file = path.join(home, "auth.json");
    // The CLI rotates the refresh token and rewrites the file itself.
    const refreshed = JSON.stringify({
      ...JSON.parse(CODEX_AUTH),
      tokens: { id_token: "id2", access_token: "at2", refresh_token: "ROTATED", account_id: "acc" }
    });
    writeFileSync(file, refreshed);

    // A routine spawn re-materializes from the (unchanged) vault copy. Writing
    // the stale credential back would silently revoke the CLI's session.
    await materializeAccountHome("work", "openai", CODEX_AUTH);
    expect(JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token).toBe("ROTATED");

    // A genuinely NEW credential (re-login, re-import) must land.
    const relogin = JSON.stringify({
      ...JSON.parse(CODEX_AUTH),
      tokens: { id_token: "id3", access_token: "at3", refresh_token: "FRESH", account_id: "acc" }
    });
    await materializeAccountHome("work", "openai", relogin);
    expect(JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token).toBe("FRESH");
  });

  it("injects a config home at spawn, never the credential as an env var", async () => {
    await addAccount({
      name: "work",
      token: CODEX_AUTH,
      platform: "openai",
      credential_kind: "auth-file"
    });
    await addAccount({
      name: "gem",
      token: GEMINI_CREDS,
      platform: "google",
      credential_kind: "auth-file"
    });
    const env = await resolveRuntimeAccountEnv([
      { id: "codex-runtime", account: "work" },
      { id: "gemini-runtime", account: "gem" }
    ]);
    expect(env.CODEX_HOME).toBe(accountHomeDir("work", "openai"));
    expect(env.GEMINI_CLI_HOME).toBe(accountHomeDir("gem", "google"));
    // The credential is a file, not a key: it must never leak into the env.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("rt");
  });

  it("still injects plain API keys as env vars alongside", async () => {
    await addAccount({ name: "key1", token: "sk-live", platform: "openai" });
    const env = await resolveRuntimeAccountEnv([{ id: "codex-runtime", account: "key1" }]);
    expect(env.OPENAI_API_KEY).toBe("sk-live");
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("removes the materialized home with the account", async () => {
    await addAccount({
      name: "work",
      token: CODEX_AUTH,
      platform: "openai",
      credential_kind: "auth-file"
    });
    const home = await materializeAccountHome("work", "openai", CODEX_AUTH);
    expect(existsSync(home)).toBe(true);
    await removeAccount("work");
    // A live credential must not outlive its registry row.
    expect(existsSync(home)).toBe(false);
  });
});

describe("gemini probe classification (V4)", () => {
  it("separates a bad credential from a plan that doesn't cover the CLI", async () => {
    const { classifyGeminiProbe } = await import("@/lib/account-login");

    // Verified live 2026-07-25 against a real, freshly-issued Google credential:
    // the OAuth succeeded, the plan did not carry Code Assist.
    const ineligible = classifyGeminiProbe(
      1,
      "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate..."
    );
    expect(ineligible.outcome).toBe("not-entitled");
    expect(ineligible.detail).toContain("no Gemini Code Assist entitlement");
    // Re-logging-in cannot fix an entitlement, so it must not read as rejected.
    expect(ineligible.outcome).not.toBe("rejected");

    expect(classifyGeminiProbe(1, "invalid_grant: token has been expired or revoked").outcome).toBe(
      "rejected"
    );
    expect(classifyGeminiProbe(0, "OK").outcome).toBe("verified");
    // The trust refusal is an environment problem, not a credential verdict.
    expect(classifyGeminiProbe(1, "not running in a trusted directory").outcome).toBe("inconclusive");
  });
});
