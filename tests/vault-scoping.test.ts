import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  unlockVault,
  writeVaultSecrets,
  scopedSecrets,
  currentSecretValuesSync,
  setOAuthGrant,
  getAccessToken,
  revokeOAuthGrant,
  oauthHealth,
  setOAuthRefresher
} from "@/lib/vault";
import { vaultEnvForEntry } from "@/lib/own-port-lifecycle";
import { recordVaultAccess, readVaultAudit } from "@/lib/vault-audit";
import { redactSecretValues, REDACTED } from "@/lib/secret-redaction";
import { resetMasterKeyCache } from "@/lib/keychain";
import type { LibraryEntry } from "@/lib/types";

// A2 — per-connector scoping, OAuth refresh/rotation, JIT value redaction, audit
// log. Sandboxed vault + audit paths; OAuth refresher injected (no network);
// vitest ephemeral master key (no OS keychain).

let dir: string;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

function fakeEntry(id: string, scope?: string[]): LibraryEntry {
  return {
    id,
    name: id,
    faculty: "connectors",
    repo: "local",
    summary: "",
    platforms: ["claude-code"],
    ratings: {},
    metadata: {
      faculty: "connectors",
      cardinality_hint: "multi",
      component_shape: "cli",
      platforms: ["claude-code"],
      config_schema: [],
      provides: [{ kind: "connector", name: id }],
      consumes: [{ kind: "vault", cardinality: "one" }],
      verify: { command: "echo ok", expect: "ok", timeout_ms: 1000 },
      ...(scope ? { secret_scope: scope } : {})
    }
  } as unknown as LibraryEntry;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-vault-scope-"));
  process.env.GARRISON_VAULT_PATH = path.join(dir, "vault.json");
  process.env.GARRISON_VAULT_AUDIT_PATH = path.join(dir, "audit.jsonl");
  process.env.VAULT_UNLOCKED = "true";
  resetVaultRuntime();
  await unlockVault();
  await writeVaultSecrets([
    { key: "SLACK_TOKEN", value: "xoxb-slack-secret" },
    { key: "GOOGLE_KEY", value: "google-secret-value" },
    { key: "TRELLO_KEY", value: "trello-secret-value" }
  ]);
});

afterEach(() => {
  delete process.env.GARRISON_VAULT_PATH;
  delete process.env.GARRISON_VAULT_AUDIT_PATH;
  delete process.env.VAULT_UNLOCKED;
  setOAuthRefresher(null);
  resetVaultRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe("per-connector scoping (A2)", () => {
  it("scopedSecrets returns only the named secrets", async () => {
    const secrets = await scopedSecrets(["SLACK_TOKEN"]);
    expect(secrets).toEqual([{ key: "SLACK_TOKEN", value: "xoxb-slack-secret" }]);
  });

  it("a connector with secret_scope reads ONLY its own secret", async () => {
    const env = await vaultEnvForEntry(fakeEntry("slack", ["SLACK_TOKEN"]));
    expect(env).toEqual({ SLACK_TOKEN: "xoxb-slack-secret" });
    expect(env.GOOGLE_KEY).toBeUndefined();
    expect(env.TRELLO_KEY).toBeUndefined();
  });

  it("fail-closed: a vault consumer without secret_scope gets NO secrets, audited as denied", async () => {
    const env = await vaultEnvForEntry(fakeEntry("legacy"));
    expect(env).toEqual({});
    const audit = await readVaultAudit();
    expect(
      audit.some((e) => e.connector === "legacy" && e.action === "denied" && e.detail === "no-secret-scope")
    ).toBe(true);
  });

  it("scoped delivery records an audit entry with the secret name", async () => {
    await vaultEnvForEntry(fakeEntry("slack", ["SLACK_TOKEN"]));
    const audit = await readVaultAudit();
    const entry = audit.find((e) => e.connector === "slack" && e.action === "deliver");
    expect(entry?.secrets).toEqual(["SLACK_TOKEN"]);
    expect(entry?.outcome).toBe("ok");
  });
});

describe("JIT value redaction (A2)", () => {
  it("currentSecretValuesSync exposes the unlocked secret values", () => {
    const values = currentSecretValuesSync();
    expect(values).toContain("xoxb-slack-secret");
    expect(values).toContain("google-secret-value");
  });

  it("redactSecretValues masks every secret value in a log line", () => {
    const line = "calling api with token xoxb-slack-secret and key google-secret-value done";
    const masked = redactSecretValues(line, currentSecretValuesSync());
    expect(masked).not.toContain("xoxb-slack-secret");
    expect(masked).not.toContain("google-secret-value");
    expect(masked).toContain(REDACTED);
  });

  it("masks even a SHORT secret value (the guarantee is absolute, not length-gated)", () => {
    const masked = redactSecretValues("pin is abcd here", ["abcd"]);
    expect(masked).not.toContain("abcd");
    expect(masked).toContain(REDACTED);
  });
});

describe("OAuth refresh + rotation (A2)", () => {
  it("returns a stored access token while valid", async () => {
    await setOAuthGrant("google", {
      accessToken: "tok-valid",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 3600_000).toISOString()
    });
    expect(await getAccessToken("google")).toBe("tok-valid");
  });

  it("auto-refreshes an expired token and rotates it", async () => {
    let refreshCalls = 0;
    setOAuthRefresher(async () => {
      refreshCalls += 1;
      return { accessToken: "tok-refreshed", expiresInSec: 3600, refreshToken: "refresh-2" };
    });
    await setOAuthGrant("google", {
      accessToken: "tok-expired",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      tokenUrl: "https://oauth.example/token"
    });
    const token = await getAccessToken("google");
    expect(token).toBe("tok-refreshed");
    expect(refreshCalls).toBe(1);
    // The rotation persisted: a second call uses the refreshed (now-valid) token.
    expect(await getAccessToken("google")).toBe("tok-refreshed");
    expect(refreshCalls).toBe(1);
    const audit = await readVaultAudit();
    expect(audit.some((e) => e.connector === "google" && e.action === "refresh")).toBe(true);
  });

  it("serializes concurrent refreshes for the same connector (no double-refresh / token loss)", async () => {
    let refreshCalls = 0;
    setOAuthRefresher(async () => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: "tok-refreshed", expiresInSec: 3600 };
    });
    await setOAuthGrant("race", {
      accessToken: "tok-expired",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      tokenUrl: "https://oauth.example/token"
    });
    const [a, b] = await Promise.all([getAccessToken("race"), getAccessToken("race")]);
    expect(a).toBe("tok-refreshed");
    expect(b).toBe("tok-refreshed");
    expect(refreshCalls).toBe(1);
  });

  it("a revoked grant flips to Reconnect (throws) and reports revoked health", async () => {
    await setOAuthGrant("trello", { accessToken: "t" });
    await revokeOAuthGrant("trello");
    await expect(getAccessToken("trello")).rejects.toThrow(/reconnect/i);
    const health = await oauthHealth();
    expect(health.find((h) => h.connector === "trello")?.status).toBe("revoked");
  });

  it("classifies token health (valid / expiring / expired)", async () => {
    await setOAuthGrant("a", { accessToken: "x", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    await setOAuthGrant("b", { accessToken: "x", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await setOAuthGrant("c", { accessToken: "x", expiresAt: new Date(Date.now() - 1000).toISOString() });
    const health = await oauthHealth();
    expect(health.find((h) => h.connector === "a")?.status).toBe("valid");
    expect(health.find((h) => h.connector === "b")?.status).toBe("expiring");
    expect(health.find((h) => h.connector === "c")?.status).toBe("expired");
  });
});

describe("audit log (A2)", () => {
  it("appends and reads back entries", async () => {
    await recordVaultAccess({ connector: "x", secrets: ["K"], action: "read", outcome: "ok" });
    const audit = await readVaultAudit();
    expect(audit.at(-1)).toMatchObject({ connector: "x", action: "read", outcome: "ok" });
  });

  it("writing a plain secret preserves stored OAuth grants", async () => {
    await setOAuthGrant("keepme", { accessToken: "tok" });
    await writeVaultSecrets([{ key: "NEW", value: "value-1" }]);
    const health = await oauthHealth();
    expect(health.some((h) => h.connector === "keepme")).toBe(true);
  });
});
