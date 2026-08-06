// The proxy route end to end, against a real HTTP server standing in for Cortex.
//
// The allowlist has its own unit test; what this one pins is the behaviour a
// mocked fetch would let drift:
//
//  - The Vault key is attached SERVER-side and never appears in what the browser
//    gets back. That is the entire reason the route exists.
//  - The upstream status is REPORTED, not mirrored. Cortex says HTTP 200 for a
//    refused action and HTTP 403 for a consent gate; if either became the
//    Garrison response status, the client's `res.ok` would describe the wrong
//    layer and the view could not tell "the action was refused" from "the proxy
//    broke".
//  - A refusal happens BEFORE a request is built, so a non-allowlisted path
//    cannot reach the far side even once.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const API_KEY = "ekoa_gk_test_key_do_not_log";

// The composition is the real lookup path for `base_url` (the session view
// autosaves it there), so it is what gets substituted - not the env fallback.
let baseUrl = "";
vi.mock("@/lib/active-composition", () => ({
  getActiveComposition: async () => "test-composition"
}));
vi.mock("@/lib/compositions", () => ({
  readComposition: async () => ({
    selections: { connectors: [{ id: "cortex-automations", config: { base_url: baseUrl } }] }
  })
}));

let vaultAnswer: () => Array<{ key: string; value: string }> = () => [
  { key: "CORTEX_API_KEY", value: API_KEY }
];
vi.mock("@/lib/vault", () => ({
  scopedSecrets: async () => vaultAnswer()
}));

const { POST } = await import("@/app/api/cortex/route");

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

let server: http.Server;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { items: [] } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body
      });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  vaultAnswer = () => [{ key: "CORTEX_API_KEY", value: API_KEY }];
});

afterEach(() => {
  reply = { status: 200, body: { items: [] } };
});

function post(body: unknown) {
  return POST(
    new Request("http://127.0.0.1:8777/api/cortex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
      // The handler only reads .json() and .nextUrl is untouched here.
    }) as never
  );
}

describe("the Cortex proxy carries the key and reports the far side verbatim", () => {
  it("attaches the Vault key server-side and keeps it out of the response", async () => {
    reply = { status: 200, body: { items: [{ key: "google-workspace" }] } };

    const response = await post({ path: "/api/v1/integrations", method: "GET" });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/api/v1/integrations");
    expect(seen[0].auth).toBe(`Bearer ${API_KEY}`);

    expect(payload.upstream.status).toBe(200);
    expect(payload.upstream.body).toEqual({ items: [{ key: "google-workspace" }] });
    expect(JSON.stringify(payload)).not.toContain(API_KEY);
  });

  it("passes a POST body through unchanged", async () => {
    reply = { status: 200, body: { success: true, data: { messages: [] } } };

    await post({
      path: "/api/v1/integrations/google-workspace/actions/gmail.messages.list/execute",
      method: "POST",
      body: { args: { maxResults: 5 } }
    });

    expect(JSON.parse(seen[0].body)).toEqual({ args: { maxResults: 5 } });
  });

  // T1. HTTP 200 is not success; the `success` field is. The route must not
  // "helpfully" turn a refusal into a Garrison error, or the view loses the
  // distinction between a refused action and a broken proxy.
  it("reports a refused action (HTTP 200, success false) as a successful round trip", async () => {
    reply = { status: 200, body: { success: false, code: "not_connected" } };

    const response = await post({
      path: "/api/v1/integrations/google-workspace/actions/gmail.messages.list/execute",
      method: "POST",
      body: { args: {} }
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.upstream.status).toBe(200);
    expect(payload.upstream.body).toEqual({ success: false, code: "not_connected" });
  });

  // T2. A consent gate is HTTP 403 with a descriptor naming the real
  // destination. The descriptor has to survive intact - it is the only thing
  // that tells a human what they would be approving.
  it("passes a 403 consent gate through with its descriptor, without becoming a 403 itself", async () => {
    const consentRequest = {
      integrationKey: "google-workspace",
      actionName: "gmail.messages.send",
      description: "Send an email",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      shape: "send_email"
    };
    reply = {
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "awaiting consent",
          details: { code: "awaiting_consent", consentRequest }
        }
      }
    };

    const response = await post({
      path: "/api/v1/integrations/google-workspace/actions/gmail.messages.send/execute",
      method: "POST",
      body: { args: {} }
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.upstream.status).toBe(403);
    expect(payload.upstream.body.error.details.code).toBe("awaiting_consent");
    expect(payload.upstream.body.error.details.consentRequest).toEqual(consentRequest);
  });
});

describe("the Cortex proxy refuses before it builds a request", () => {
  it("a non-allowlisted path never reaches the far side", async () => {
    const response = await post({ path: "/api/v1/knowledge/search", method: "POST", body: {} });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not on the Cortex proxy allowlist");
    expect(seen, "the upstream must not have been contacted at all").toEqual([]);
  });

  it("no key means 409 and no outbound request, rather than an anonymous call", async () => {
    vaultAnswer = () => [];

    const response = await post({ path: "/api/v1/integrations", method: "GET" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("CORTEX_API_KEY");
    expect(seen).toEqual([]);
  });

  it("a locked Vault is a 409 that says so, not a silent failure", async () => {
    vaultAnswer = () => {
      throw new Error("Vault is locked");
    };

    const response = await post({ path: "/api/v1/integrations", method: "GET" });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toContain("Vault is locked");
    expect(seen).toEqual([]);
  });

  it("an unreachable base URL is a 502 naming the address, so a typo is debuggable", async () => {
    const good = baseUrl;
    // Port 1 on loopback: nothing listens, and the connection refusal is immediate.
    baseUrl = "http://127.0.0.1:1";
    try {
      const response = await post({ path: "/api/v1/integrations", method: "GET" });
      const payload = await response.json();
      expect(response.status).toBe(502);
      expect(payload.error).toContain("http://127.0.0.1:1/api/v1/integrations");
    } finally {
      baseUrl = good;
    }
  });
});
