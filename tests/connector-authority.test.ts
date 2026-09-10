import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startStateService } from "./state-service-harness";
import { resetStateClient } from "@/lib/state-client";
import { credentialNames, getAccessToken, oauthHealth, revokeOAuthGrant, scopedSecrets, setOAuthGrant, writeConnectorSecrets } from "@/lib/connector-auth";
import { ensureCaptureCredential } from "@/lib/capture-credential";

let service: Awaited<ReturnType<typeof startStateService>>;
const saved = { ...process.env };
beforeAll(async () => {
  service = await startStateService({ nodes: ["connector-one", "connector-two"] });
  process.env.GARRISON_STATE_URL = service.url;
  process.env.GARRISON_STATE_TOKEN = service.token;
  process.env.GARRISON_NODE_NAME = "connector-one";
  resetStateClient();
  await service.client.putGrant("connector-one", "*");
  await service.client.putGrant("connector-two", "*");
}, 30_000);
afterAll(async () => {
  for (const key of ["GARRISON_STATE_URL", "GARRISON_STATE_TOKEN", "GARRISON_NODE_NAME"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  resetStateClient();
  await service?.stop();
});

describe("mesh connector credentials", () => {
  it("writes only the changed keys and resolves the shared source", async () => {
    await service.client.putSecret("UNRELATED_KEY", "keep-me");
    await writeConnectorSecrets({ GOOGLE_OAUTH_CLIENT_ID: "test-client", GOOGLE_OAUTH_CLIENT_SECRET: "test-secret" });
    expect(await credentialNames()).toEqual(expect.arrayContaining(["UNRELATED_KEY", "GOOGLE_OAUTH_CLIENT_ID"]));
    expect(await scopedSecrets(["GOOGLE_OAUTH_CLIENT_ID"])).toEqual([{ key: "GOOGLE_OAUTH_CLIENT_ID", value: "test-client" }]);
    expect((await service.client.resolveSecrets(["UNRELATED_KEY"])).values.UNRELATED_KEY).toBe("keep-me");
  });

  it("preserves one generated capture credential across concurrent provisioning and restarts", async () => {
    const tokens = await Promise.all(Array.from({ length: 6 }, () => ensureCaptureCredential()));
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(1);
    resetStateClient();
    expect(await ensureCaptureCredential()).toBe(tokens[0]);
  });

  it("shares a stored OAuth grant and refreshes it once under concurrent calls", async () => {
    await setOAuthGrant("google", { accessToken: "old", refreshToken: "refresh", clientId: "test-client", clientSecretKey: "GOOGLE_OAUTH_CLIENT_SECRET", tokenUrl: "https://oauth.example.test/token", expiresAt: new Date(0).toISOString() });
    resetStateClient();
    expect(await oauthHealth()).toEqual([expect.objectContaining({ connector: "google", status: "expiring" })]);
    const originalFetch = globalThis.fetch;
    let refreshes = 0;
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) !== "https://oauth.example.test/token") return originalFetch(input, init);
      refreshes++;
      expect(String(init?.body)).toContain("refresh_token=refresh");
      return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 });
    });
    try {
      expect(await Promise.all([getAccessToken("google"), getAccessToken("google")])).toEqual(["new", "new"]);
      expect(refreshes).toBe(1);
    } finally { mock.mockRestore(); }
    await revokeOAuthGrant("google");
    resetStateClient();
    await expect(getAccessToken("google")).rejects.toThrow("not connected");
    expect(await oauthHealth()).toEqual([expect.objectContaining({ status: "revoked" })]);
  });
});
