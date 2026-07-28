import { describe, expect, it } from "vitest";
import { fetchAccountBalance, balanceSupported } from "@/lib/account-balance";
import { PLATFORM_SPECS, accountAuthEnv } from "@/lib/account-env";

// RUNTIME-ACCOUNTS-V4 — credits/spend for API-key accounts. The point of these
// tests is that Garrison reports what a provider ACTUALLY exposes: a real number
// where one exists, an identity where only that exists, and a stated reason
// where there is nothing - never a blank or an invented figure.

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
}

describe("balance support", () => {
  it("claims support only where a real balance is knowable", () => {
    expect(balanceSupported("openrouter")).toBe(true);
    expect(balanceSupported("huggingface")).toBe(true);
    expect(balanceSupported("anthropic")).toBe(false);
    expect(balanceSupported("openai")).toBe(false);
    expect(balanceSupported("google")).toBe(false);
  });
});

describe("openrouter", () => {
  it("reports remaining credits and the consumed ratio", async () => {
    const balance = await fetchAccountBalance(
      "openrouter",
      "sk-or-test",
      jsonFetch(200, { data: { total_credits: 20, total_usage: 5 } })
    );
    expect(balance.kind).toBe("available");
    expect(balance.label).toBe("$15.00 left of $20.00");
    expect(balance.usedPct).toBeCloseTo(25);
  });

  it("says so when the key is refused", async () => {
    const balance = await fetchAccountBalance("openrouter", "bad", jsonFetch(401, {}));
    expect(balance.kind).toBe("unavailable");
    expect(balance.detail).toContain("refused");
  });
});

describe("huggingface", () => {
  it("reports the identity behind the token, and that there is no credit balance", async () => {
    const balance = await fetchAccountBalance(
      "huggingface",
      "hf_test",
      jsonFetch(200, { name: "ggomes", plan: "pro", auth: { accessToken: { role: "write" } } })
    );
    expect(balance.kind).toBe("identity");
    expect(balance.label).toBe("signed in as ggomes (pro)");
    expect(balance.detail).toContain("no credit balance");
    expect(balance.usedPct).toBeNull();
  });
});

describe("providers with no balance for standard keys", () => {
  it("explains WHY rather than showing an empty number", async () => {
    const anthropic = await fetchAccountBalance("anthropic", "sk-ant-x", jsonFetch(401, {}));
    expect(anthropic.kind).toBe("unavailable");
    expect(anthropic.detail).toContain("Admin API keys");

    const openai = await fetchAccountBalance("openai", "sk-x", jsonFetch(401, {}));
    expect(openai.detail).toContain("Admin keys");

    const google = await fetchAccountBalance("google", "AIza", jsonFetch(200, {}));
    expect(google.detail).toContain("GCP");
  });

  it("treats an unreachable provider as unavailable, not as a bad key", async () => {
    const boom = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    const balance = await fetchAccountBalance("openrouter", "sk-or", boom);
    expect(balance.kind).toBe("unavailable");
    expect(balance.detail).toContain("could not reach");
  });
});

describe("new provider platforms", () => {
  it("injects the env vars each provider's runtime reads", () => {
    expect(accountAuthEnv("k", "sk-or-v1-x", "openrouter").OPENROUTER_API_KEY).toBe("sk-or-v1-x");
    const hf = accountAuthEnv("k", "hf_x", "huggingface");
    // The HF ecosystem reads both names depending on library version.
    expect(hf.HF_TOKEN).toBe("hf_x");
    expect(hf.HUGGING_FACE_HUB_TOKEN).toBe("hf_x");
  });

  it("has no machine login or auth file - these are key-only providers", () => {
    for (const platform of ["openrouter", "huggingface"] as const) {
      expect(PLATFORM_SPECS[platform].nativeLoginPath).toBeNull();
      expect(PLATFORM_SPECS[platform].authFile).toBeUndefined();
      expect(PLATFORM_SPECS[platform].browserLogin).toBeUndefined();
    }
  });
});
