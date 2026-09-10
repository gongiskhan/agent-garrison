import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetOAuthState } from "../src/lib/oauth-state";

// End-to-end route coverage for the Google Workspace (and any other oauth2)
// connector's authorization-code flow: /oauth-start builds the provider URL
// with the user's own client id, /oauth-callback exchanges the code for
// tokens and seals the grant in the Vault.

const mocks = vi.hoisted(() => ({
  scopedSecrets: vi.fn(async (names: string[]) =>
    names.map((key) => ({ key, value: "" }))
  ),
  setOAuthGrant: vi.fn(async () => {})
}));

vi.mock("@/lib/vault", () => ({
  scopedSecrets: mocks.scopedSecrets,
  setOAuthGrant: mocks.setOAuthGrant
}));

const GOOGLE_ENTRY = {
  id: "google",
  name: "Google Workspace",
  metadata: {
    provides: [{ kind: "connector", name: "google" }],
    connector: {
      auth: "oauth2",
      actions: [],
      oauth: {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
        clientIdSecret: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretSecret: "GOOGLE_OAUTH_CLIENT_SECRET"
      }
    }
  }
};

vi.mock("@/lib/library", () => ({
  readLibrary: vi.fn(async () => [GOOGLE_ENTRY])
}));

import { GET as oauthStart } from "../src/app/api/connectors/[id]/oauth-start/route";
import { GET as oauthCallback } from "../src/app/api/connectors/[id]/oauth-callback/route";

function req(url: string) {
  return new Request(url);
}

describe("connector OAuth routes (google)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSecrets.mockImplementation(async (names: string[]) => names.map((key) => ({ key, value: "" })));
    _resetOAuthState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetOAuthState();
  });

  it("returns 409 + the redirect URI to register when client credentials are unset", async () => {
    const res = await oauthStart(req("https://node.tail.ts.net/api/connectors/google/oauth-start"), {
      params: { id: "google" }
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("client-credentials-missing");
    expect(body.needs).toEqual(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);
    expect(body.redirectUri).toBe("https://node.tail.ts.net/api/connectors/google/oauth-callback");
  });

  it("returns 409 when the client id is set but the client secret is still missing", async () => {
    mocks.scopedSecrets.mockImplementation(async (names: string[]) =>
      names.map((key) => ({ key, value: key === "GOOGLE_OAUTH_CLIENT_ID" ? "client-123" : "" }))
    );
    const res = await oauthStart(req("https://node.tail.ts.net/api/connectors/google/oauth-start"), {
      params: { id: "google" }
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("client-credentials-missing");
    expect(body.needs).toEqual(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);
  });

  it("builds the Google authorize URL from the browser's own origin, not a loopback one", async () => {
    mocks.scopedSecrets.mockImplementation(async (names: string[]) =>
      names.map((key) => ({ key, value: key === "GOOGLE_OAUTH_CLIENT_ID" ? "client-123" : "secret-456" }))
    );
    const res = await oauthStart(
      req("http://127.0.0.1:8777/api/connectors/google/oauth-start"),
      { params: { id: "google" } }
    );
    // simulate tailscale serve fronting the loopback process
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUrl).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(body.authUrl).toContain("client_id=client-123");
    expect(body.authUrl).toContain("access_type=offline");
    expect(body.authUrl).toContain("prompt=consent");
    const encodedRedirect = new URL(body.authUrl).searchParams.get("redirect_uri");
    expect(body.redirectUri).toBe(encodedRedirect);
  });

  it("honors x-forwarded-host/proto so the tailnet browser origin drives the redirect URI", async () => {
    mocks.scopedSecrets.mockImplementation(async (names: string[]) =>
      names.map((key) => ({ key, value: key === "GOOGLE_OAUTH_CLIENT_ID" ? "client-123" : "secret-456" }))
    );
    const request = new Request("http://127.0.0.1:8777/api/connectors/google/oauth-start", {
      headers: { "x-forwarded-host": "goncalos-macbook-pro.tail31efa.ts.net", "x-forwarded-proto": "https" }
    });
    const res = await oauthStart(request, { params: { id: "google" } });
    const body = await res.json();
    expect(body.redirectUri).toBe(
      "https://goncalos-macbook-pro.tail31efa.ts.net/api/connectors/google/oauth-callback"
    );
    expect(decodeURIComponent(body.authUrl)).toContain(
      "redirect_uri=https://goncalos-macbook-pro.tail31efa.ts.net/api/connectors/google/oauth-callback"
    );
  });

  it("exchanges the code for tokens and seals the grant in the Vault, then redirects with ?connected=", async () => {
    mocks.scopedSecrets.mockImplementation(async (names: string[]) =>
      names.map((key) => ({
        key,
        value: key === "GOOGLE_OAUTH_CLIENT_ID" ? "client-123" : "secret-456"
      }))
    );
    const startRes = await oauthStart(req("https://node.tail.ts.net/api/connectors/google/oauth-start"), {
      params: { id: "google" }
    });
    const { authUrl } = await startRes.json();
    const state = new URL(authUrl).searchParams.get("state")!;
    expect(state).toBeTruthy();

    let tokenReqBody: URLSearchParams | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      tokenReqBody = new URLSearchParams(String(init?.body));
      return new Response(
        JSON.stringify({ access_token: "ya29.abc", refresh_token: "1//refresh", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const callbackRes = await oauthCallback(
      req(`https://node.tail.ts.net/api/connectors/google/oauth-callback?code=auth-code-1&state=${state}`),
      { params: { id: "google" } }
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenReqBody!.get("grant_type")).toBe("authorization_code");
    expect(tokenReqBody!.get("code")).toBe("auth-code-1");
    expect(tokenReqBody!.get("client_id")).toBe("client-123");
    expect(tokenReqBody!.get("client_secret")).toBe("secret-456");
    expect(tokenReqBody!.get("redirect_uri")).toBe("https://node.tail.ts.net/api/connectors/google/oauth-callback");

    expect(mocks.setOAuthGrant).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({
        accessToken: "ya29.abc",
        refreshToken: "1//refresh",
        clientId: "client-123",
        clientSecretKey: "GOOGLE_OAUTH_CLIENT_SECRET",
        status: "valid"
      })
    );

    expect(callbackRes.status).toBe(307); // redirect
    expect(callbackRes.headers.get("location")).toBe("https://node.tail.ts.net/connectors?connected=google");
  });

  it("rejects a replayed callback state (single-use CSRF)", async () => {
    mocks.scopedSecrets.mockImplementation(async (names: string[]) =>
      names.map((key) => ({ key, value: "x" }))
    );
    const startRes = await oauthStart(req("https://node.tail.ts.net/api/connectors/google/oauth-start"), {
      params: { id: "google" }
    });
    const { authUrl } = await startRes.json();
    const state = new URL(authUrl).searchParams.get("state")!;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "t" }), { status: 200, headers: { "content-type": "application/json" } })
      )
    );

    const first = await oauthCallback(
      req(`https://node.tail.ts.net/api/connectors/google/oauth-callback?code=c1&state=${state}`),
      { params: { id: "google" } }
    );
    expect(first.headers.get("location")).toContain("connected=google");

    const replay = await oauthCallback(
      req(`https://node.tail.ts.net/api/connectors/google/oauth-callback?code=c1&state=${state}`),
      { params: { id: "google" } }
    );
    expect(replay.headers.get("location")).toBe("https://node.tail.ts.net/connectors?connect_error=invalid_state");
  });

  it("surfaces a provider-side denial without attempting a token exchange", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await oauthCallback(
      req("https://node.tail.ts.net/api/connectors/google/oauth-callback?error=access_denied"),
      { params: { id: "google" } }
    );
    expect(res.headers.get("location")).toBe("https://node.tail.ts.net/connectors?connect_error=access_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
