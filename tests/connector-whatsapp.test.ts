import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CATALOG, runAction } from "../fittings/seed/whatsapp/scripts/connector.mjs";

// The WhatsApp connector implements the uniform connector executor contract:
// a catalog + a `call` path that hits the WhatsApp Business Cloud API (Meta
// Graph API) with Vault-scoped creds (here injected via env + a mock fetch),
// and an awaiting_connector signal when not connected.

const CREDS = {
  WHATSAPP_ACCESS_TOKEN: "tok",
  WHATSAPP_PHONE_NUMBER_ID: "pn1",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "waba1"
};

function mockFetch(captured: { url?: string; opts?: any }, body: unknown) {
  return async (url: string, opts?: any) => {
    captured.url = url;
    captured.opts = opts;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

describe("whatsapp connector", () => {
  it("exposes a connector catalog with mutating + read actions", () => {
    expect(CATALOG.service).toBe("whatsapp");
    expect(CATALOG.auth).toBe("api_key");
    const names = CATALOG.actions.map((a: any) => a.name);
    expect(names).toEqual(expect.arrayContaining(["send_text", "send_template", "list_templates"]));
    expect(CATALOG.actions.find((a: any) => a.name === "send_text")?.mutates).toBe(true);
    expect(CATALOG.actions.find((a: any) => a.name === "list_templates")?.mutates).toBe(false);
  });

  it("send_text POSTs a text message to the phone number id's messages endpoint", async () => {
    const cap: { url?: string; opts?: any } = {};
    const result = await runAction({
      action: "send_text",
      args: { to: "15551234567", body: "hello" },
      env: CREDS,
      fetchImpl: mockFetch(cap, { messages: [{ id: "wamid.1" }] })
    });
    expect(cap.url).toBe("https://graph.facebook.com/v25.0/pn1/messages");
    expect(cap.opts!.method).toBe("POST");
    expect(cap.opts!.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(cap.opts!.body)).toMatchObject({
      messaging_product: "whatsapp",
      to: "15551234567",
      type: "text",
      text: { body: "hello" }
    });
    expect(result).toEqual({ messages: [{ id: "wamid.1" }] });
  });

  it("send_template builds the template payload, defaulting language and omitting components when absent", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "send_template",
      args: { to: "15551234567", template: "order_update" },
      env: CREDS,
      fetchImpl: mockFetch(cap, { messages: [] })
    });
    const body = JSON.parse(cap.opts!.body);
    expect(body.type).toBe("template");
    expect(body.template).toEqual({ name: "order_update", language: { code: "en_US" } });
  });

  it("send_template passes components through when provided", async () => {
    const cap: { url?: string; opts?: any } = {};
    const components = [{ type: "body", parameters: [{ type: "text", text: "42" }] }];
    await runAction({
      action: "send_template",
      args: { to: "15551234567", template: "order_update", language: "pt_PT", components },
      env: CREDS,
      fetchImpl: mockFetch(cap, { messages: [] })
    });
    const body = JSON.parse(cap.opts!.body);
    expect(body.template).toEqual({ name: "order_update", language: { code: "pt_PT" }, components });
  });

  it("list_templates GETs the business account's message_templates endpoint", async () => {
    const cap: { url?: string; opts?: any } = {};
    const result = await runAction({
      action: "list_templates",
      env: CREDS,
      fetchImpl: mockFetch(cap, { data: [{ name: "order_update", status: "APPROVED" }] })
    });
    expect(cap.url).toContain("/waba1/message_templates");
    expect(cap.url).toContain("fields=");
    expect(cap.opts!.headers.authorization).toBe("Bearer tok");
    expect(result).toEqual({ data: [{ name: "order_update", status: "APPROVED" }] });
  });

  it("list_templates rejects when no business account id is configured", async () => {
    const { WHATSAPP_BUSINESS_ACCOUNT_ID, ...noWaba } = CREDS;
    await expect(
      runAction({ action: "list_templates", env: noWaba, fetchImpl: mockFetch({}, {}) })
    ).rejects.toThrow(/WHATSAPP_BUSINESS_ACCOUNT_ID/);
  });

  it("throws awaiting_connector when creds are missing", async () => {
    // No env creds AND no internal token to self-resolve them -> not connected.
    const prev = process.env.GARRISON_INTERNAL_TOKEN_PATH;
    process.env.GARRISON_INTERNAL_TOKEN_PATH = path.join(os.tmpdir(), "garrison-no-such-internal-token");
    try {
      await expect(runAction({ action: "send_text", env: {}, fetchImpl: mockFetch({}, []) })).rejects.toMatchObject({
        awaiting_connector: true
      });
    } finally {
      if (prev === undefined) delete process.env.GARRISON_INTERNAL_TOKEN_PATH;
      else process.env.GARRISON_INTERNAL_TOKEN_PATH = prev;
    }
  });

  // A direct call (not via the Automations engine) has no scoped creds in env;
  // the connector self-resolves them from Garrison's auth-env route.
  describe("self-resolves scoped creds when none are injected", () => {
    let dir: string;
    const prevPath = process.env.GARRISON_INTERNAL_TOKEN_PATH;
    const prevBase = process.env.GARRISON_BASE_URL;

    afterEach(() => {
      if (prevPath === undefined) delete process.env.GARRISON_INTERNAL_TOKEN_PATH;
      else process.env.GARRISON_INTERNAL_TOKEN_PATH = prevPath;
      if (prevBase === undefined) delete process.env.GARRISON_BASE_URL;
      else process.env.GARRISON_BASE_URL = prevBase;
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("POSTs auth-env with the internal token and uses the returned creds", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "wtok-"));
      const tokenFile = path.join(dir, "internal-token");
      writeFileSync(tokenFile, "internal-secret", { mode: 0o600 });
      process.env.GARRISON_INTERNAL_TOKEN_PATH = tokenFile;
      process.env.GARRISON_BASE_URL = "http://127.0.0.1:9999";

      const seen: { authEnvUrl?: string; internalHeader?: string; sendUrl?: string } = {};
      const fetchImpl = async (url: string, opts?: any) => {
        if (url.includes("/auth-env")) {
          seen.authEnvUrl = url;
          seen.internalHeader = opts.headers["x-garrison-internal"];
          return {
            ok: true,
            status: 200,
            json: async () => ({
              env: {
                WHATSAPP_ACCESS_TOKEN: "tok2",
                WHATSAPP_PHONE_NUMBER_ID: "pn2",
                WHATSAPP_BUSINESS_ACCOUNT_ID: "waba2"
              }
            }),
            text: async () => ""
          };
        }
        seen.sendUrl = url;
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      };

      await runAction({ action: "send_text", args: { to: "1", body: "hi" }, env: {}, fetchImpl });
      expect(seen.authEnvUrl).toBe("http://127.0.0.1:9999/api/connectors/whatsapp/auth-env");
      expect(seen.internalHeader).toBe("internal-secret");
      expect(seen.sendUrl).toBe("https://graph.facebook.com/v25.0/pn2/messages");
    });
  });

  it("rejects an unknown action", async () => {
    await expect(
      runAction({ action: "nope", env: CREDS, fetchImpl: mockFetch({}, {}) })
    ).rejects.toThrow(/unknown action/);
  });
});
