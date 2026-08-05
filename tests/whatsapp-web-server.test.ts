import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContactIndex } from "../fittings/seed/whatsapp-web/lib/contacts.mjs";
import { MessageStore } from "../fittings/seed/whatsapp-web/lib/store.mjs";
import { createApp, extractMessageText, isLoopbackAddr } from "../fittings/seed/whatsapp-web/scripts/server.mjs";

// Exercises the daemon's internal HTTP API end to end over a REAL http server
// (127.0.0.1, ephemeral port) with a FAKE connection manager standing in for
// Baileys — this Fitting's tests must never import @whiskeysockets/baileys or
// open a real socket, per the brief. The fake satisfies the exact interface
// buildConnectionManager() produces: { status, requestPairingCode, sendText }.

function fakeConnectionManager(overrides: Partial<Record<string, any>> = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  return {
    calls,
    status: () => ({ paired: false, connected: false, connecting: false, phone: null }),
    requestPairingCode: async (phoneNumber: string) => {
      calls.push({ method: "requestPairingCode", args: [phoneNumber] });
      return "ABCD1234";
    },
    sendText: async (jid: string, body: string) => {
      calls.push({ method: "sendText", args: [jid, body] });
      return { id: "wamid.fake" };
    },
    ...overrides
  };
}

describe("whatsapp-web server pure helpers", () => {
  it("isLoopbackAddr recognizes 127.x / ::1 / IPv4-mapped loopback", () => {
    expect(isLoopbackAddr("127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("127.5.5.5")).toBe(true);
    expect(isLoopbackAddr("::1")).toBe(true);
    expect(isLoopbackAddr("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("10.0.0.5")).toBe(false);
    expect(isLoopbackAddr(undefined)).toBe(false);
  });

  it("extractMessageText pulls the text out of the common Baileys message shapes", () => {
    expect(extractMessageText({ conversation: "hi" })).toBe("hi");
    expect(extractMessageText({ extendedTextMessage: { text: "hi2" } })).toBe("hi2");
    expect(extractMessageText({ imageMessage: { caption: "pic caption" } })).toBe("pic caption");
    expect(extractMessageText({})).toBe("");
    expect(extractMessageText(undefined)).toBe("");
  });
});

describe("whatsapp-web internal HTTP API", () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let store: MessageStore;
  let contactIndex: ContactIndex;
  let cm: ReturnType<typeof fakeConnectionManager>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-http-"));
    store = new MessageStore(dir);
    contactIndex = new ContactIndex();
    cm = fakeConnectionManager();
    const handler = createApp({ connectionManager: cm, store, contactIndex, port: 0, host: "127.0.0.1" });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /health reports the connection manager's status", async () => {
    const res = await fetch(`${base}/health`);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, paired: false, connected: false });
  });

  it("GET / serves the status + pairing page, with no send_text control anywhere", async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("/health");
    // Pairing is a page control now (POST /pair, a phone input, a pair button)...
    expect(html).toContain('fetch("/pair"');
    expect(html).toContain('id="phone"');
    expect(html).toContain('id="pairBtn"');
    // ...but sending a message is never reachable from this page — that stays
    // CLI-only via connector.mjs in a live conversation with the Operative.
    expect(html).not.toMatch(/\/send\b/);
    expect(html).not.toMatch(/send_text/);
  });

  it("POST /pair from the status page's own fetch call round-trips a code", async () => {
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "10000000000" })
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(typeof json.code).toBe("string");
    expect(cm.calls).toContainEqual({ method: "requestPairingCode", args: ["10000000000"] });
  });

  it("GET /resolve proxies the contact index", async () => {
    contactIndex.upsert("1@s.whatsapp.net", "Maria Silva");
    const res = await fetch(`${base}/resolve?name=maria`);
    const json = await res.json();
    expect(json.candidates).toEqual([{ name: "Maria Silva", jid: "1@s.whatsapp.net" }]);
  });

  it("GET /recent proxies the message store, newest first", async () => {
    store.append({ id: "1", chatJid: "a@s.whatsapp.net", body: "first", timestamp: 1 });
    store.append({ id: "2", chatJid: "a@s.whatsapp.net", body: "second", timestamp: 2 });
    const res = await fetch(`${base}/recent?n=5`);
    const json = await res.json();
    expect(json.messages.map((m: any) => m.id)).toEqual(["2", "1"]);
  });

  it("GET /last with an exact jid returns that chat's last message", async () => {
    store.append({ id: "1", chatJid: "1@s.whatsapp.net", body: "hi", timestamp: 1 });
    const res = await fetch(`${base}/last?chat=${encodeURIComponent("1@s.whatsapp.net")}`);
    const json = await res.json();
    expect(json.message).toMatchObject({ id: "1", body: "hi" });
  });

  it("GET /last with an unambiguous name resolves it before looking up the message", async () => {
    contactIndex.upsert("1@s.whatsapp.net", "Maria Silva");
    store.append({ id: "1", chatJid: "1@s.whatsapp.net", body: "hi", timestamp: 1 });
    const res = await fetch(`${base}/last?chat=Maria`);
    const json = await res.json();
    expect(json.message).toMatchObject({ id: "1", body: "hi" });
  });

  it("GET /last with an ambiguous name returns candidates instead of guessing", async () => {
    contactIndex.upsert("1@s.whatsapp.net", "Maria Silva");
    contactIndex.upsert("2@s.whatsapp.net", "Maria Costa");
    const res = await fetch(`${base}/last?chat=Maria`);
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.message).toBeUndefined();
  });

  it("GET /last with an unknown name returns a null message", async () => {
    const res = await fetch(`${base}/last?chat=Nobody`);
    const json = await res.json();
    expect(json.message).toBeNull();
  });

  it("POST /send delegates to the connection manager", async () => {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jid: "1@s.whatsapp.net", body: "hi" })
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, id: "wamid.fake" });
    expect(cm.calls).toEqual([{ method: "sendText", args: ["1@s.whatsapp.net", "hi"] }]);
  });

  it("POST /send surfaces awaiting_connector as HTTP 409", async () => {
    const cmNotConnected = fakeConnectionManager({
      sendText: async () => {
        const err: any = new Error("not connected");
        err.awaiting_connector = true;
        throw err;
      }
    });
    await new Promise((resolve) => server.close(resolve));
    server = http.createServer(
      createApp({ connectionManager: cmNotConnected, store, contactIndex, port: 0, host: "127.0.0.1" })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jid: "1@s.whatsapp.net", body: "hi" })
    });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.awaiting_connector).toBe(true);
  });

  it("POST /pair delegates to the connection manager and returns the code", async () => {
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "+351912345678" })
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ code: "ABCD1234" });
    expect(cm.calls).toEqual([{ method: "requestPairingCode", args: ["+351912345678"] }]);
  });

  it("an unknown route returns 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
