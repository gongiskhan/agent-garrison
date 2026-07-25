import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAccountToken, applyVerifyToRegistry } from "@/lib/account-login";
import { addAccount, listAccounts, setAccountNeedsRelogin } from "@/lib/accounts";
import { unlockVault } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

// RUNTIME-ACCOUNTS-V2 — post-capture verification. The point of these tests is
// the CLASSIFICATION: a 429 proves the token authenticated (you cannot be
// rate-limited anonymously), so a scorched window must never be reported as a
// failed login or flag the account for re-login.

let dir: string;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

const TOKEN = "sk-ant-oat01-test-token-verify-0123456789";

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "anthropic-ratelimit-unified-5h-utilization": "0.12",
    "anthropic-ratelimit-unified-5h-reset": "1784659200",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.34",
    "anthropic-ratelimit-unified-7d-reset": "1785264000",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-status": "allowed",
    ...overrides
  };
}

function fakeFetch(status: number, headerMap: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(status === 204 ? null : "{}", { status, headers: headerMap })) as typeof fetch;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-verify-"));
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

describe("verifyAccountToken — anthropic", () => {
  it("reports a live token as verified, with its usage numbers", async () => {
    const verify = await verifyAccountToken("work1", TOKEN, "anthropic", fakeFetch(200, headers()));
    expect(verify.outcome).toBe("verified");
    expect(verify.ok).toBe(true);
    expect(verify.usage).toEqual({ fiveHourPct: 12, weeklyPct: 34, resetAt: expect.any(String) });
    expect(verify.detail).toContain("5h 12%");
  });

  it("reports a 429 as rate-limited, NOT as a failed login", async () => {
    const verify = await verifyAccountToken(
      "work1",
      TOKEN,
      "anthropic",
      fakeFetch(
        429,
        headers({
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-status": "rejected"
        })
      )
    );
    expect(verify.outcome).toBe("rate-limited");
    // The token is usable — the account simply has no headroom this window.
    expect(verify.ok).toBe(true);
    expect(verify.detail).toContain("accepted the token");
  });

  it("reports a 401 as rejected", async () => {
    const verify = await verifyAccountToken("work1", TOKEN, "anthropic", fakeFetch(401));
    expect(verify.outcome).toBe("rejected");
    expect(verify.ok).toBe(false);
  });

  it("reports an unreachable provider as inconclusive, not rejected", async () => {
    const boom = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const verify = await verifyAccountToken("work1", TOKEN, "anthropic", boom);
    expect(verify.outcome).toBe("inconclusive");
    expect(verify.ok).toBe(false);
  });
});

describe("verifyAccountToken — other platforms", () => {
  it("verifies an OpenAI key with a cheap authenticated GET", async () => {
    const ok = await verifyAccountToken("codex1", "sk-live", "openai", fakeFetch(200));
    expect(ok.outcome).toBe("verified");
    const bad = await verifyAccountToken("codex1", "sk-bad", "openai", fakeFetch(401));
    expect(bad.outcome).toBe("rejected");
  });

  it("verifies a Google key", async () => {
    const ok = await verifyAccountToken("gem1", "AIza-live", "google", fakeFetch(200));
    expect(ok.outcome).toBe("verified");
  });

  it("says so rather than claiming success for a custom platform", async () => {
    const verify = await verifyAccountToken("mistral", "tok", "custom");
    expect(verify.outcome).toBe("unverifiable");
    expect(verify.detail).toContain("no probe");
  });
});

describe("applyVerifyToRegistry", () => {
  it("flags re-login ONLY on a provider refusal", async () => {
    await addAccount({ name: "work1", token: TOKEN });

    await applyVerifyToRegistry("work1", { ok: false, outcome: "rejected", detail: "" });
    expect((await listAccounts()).find((a) => a.name === "work1")?.needs_relogin).toBe(true);

    // A rate-limited account is a WORKING account — it must come back.
    await applyVerifyToRegistry("work1", { ok: true, outcome: "rate-limited", detail: "" });
    expect((await listAccounts()).find((a) => a.name === "work1")?.needs_relogin).toBeFalsy();
  });

  it("leaves the flag untouched when the probe was inconclusive", async () => {
    await addAccount({ name: "work1", token: TOKEN });
    await setAccountNeedsRelogin("work1", true);
    await applyVerifyToRegistry("work1", { ok: false, outcome: "inconclusive", detail: "" });
    expect((await listAccounts()).find((a) => a.name === "work1")?.needs_relogin).toBe(true);
  });
});
