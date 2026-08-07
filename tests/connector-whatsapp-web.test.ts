import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG, runAction } from "../fittings/seed/whatsapp-web/scripts/connector.mjs";

// whatsapp-web's connector.mjs implements the uniform connector executor
// contract (catalog + call), but instead of calling an external HTTP API
// directly (like whatsapp/slack), it proxies a locally running own-port
// daemon discovered via its status file. These tests fake that daemon with a
// mock fetchImpl and a temp status file — no Baileys, no real daemon, no
// network.

function statusFile(dir: string, url = "http://127.0.0.1:9999") {
  const file = path.join(dir, "whatsapp-web.json");
  writeFileSync(file, JSON.stringify({ fittingId: "whatsapp-web", port: 9999, url, pid: 1 }));
  return file;
}

function mockFetch(cap: { calls: Array<{ url: string; opts?: any }> }, respond: (url: string, opts?: any) => any) {
  return async (url: string, opts?: any) => {
    cap.calls.push({ url, opts });
    const body = respond(url, opts);
    return {
      ok: body.status === undefined || body.status < 400,
      status: body.status ?? 200,
      json: async () => body.json ?? {},
      text: async () => JSON.stringify(body.json ?? {})
    };
  };
}

describe("whatsapp-web connector catalog", () => {
  it("exposes resolve_contact, send_text, recent_messages, last_message", () => {
    expect(CATALOG.service).toBe("whatsapp-web");
    expect(CATALOG.auth).toBe("none");
    const names = CATALOG.actions.map((a: any) => a.name);
    expect(names).toEqual(
      expect.arrayContaining(["resolve_contact", "send_text", "recent_messages", "last_message"])
    );
    expect(CATALOG.actions.find((a: any) => a.name === "send_text")?.mutates).toBe(true);
    expect(CATALOG.actions.find((a: any) => a.name === "resolve_contact")?.mutates).toBe(false);
  });

  it("declares no batch-send action", () => {
    const names = CATALOG.actions.map((a: any) => a.name);
    expect(names.some((n: string) => /batch|bulk|many/i.test(n))).toBe(false);
  });
});

describe("whatsapp-web connector runAction", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("throws awaiting_connector when the daemon status file is missing", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: path.join(dir, "does-not-exist.json") };
    await expect(runAction({ action: "resolve_contact", args: { name: "Maria" }, env })).rejects.toMatchObject({
      awaiting_connector: true
    });
  });

  it("resolve_contact GETs /resolve and returns the candidate list", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    const cap = { calls: [] as any[] };
    const fetchImpl = mockFetch(cap, () => ({
      json: { candidates: [{ name: "Maria Silva", jid: "1@s.whatsapp.net" }] }
    }));
    const result = await runAction({ action: "resolve_contact", args: { name: "Maria" }, env, fetchImpl });
    expect(result).toEqual([{ name: "Maria Silva", jid: "1@s.whatsapp.net" }]);
    expect(cap.calls[0].url).toBe("http://127.0.0.1:9999/resolve?name=Maria");
  });

  it("send_text rejects a bare name WITHOUT calling the daemon", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    const cap = { calls: [] as any[] };
    const fetchImpl = mockFetch(cap, () => ({ json: { ok: true } }));
    await expect(
      runAction({ action: "send_text", args: { to: "Maria", body: "hi" }, env, fetchImpl })
    ).rejects.toThrow(/resolve_contact/);
    expect(cap.calls).toHaveLength(0);
  });

  it("send_text rejects a phone number without the jid suffix", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    const cap = { calls: [] as any[] };
    const fetchImpl = mockFetch(cap, () => ({ json: { ok: true } }));
    await expect(
      runAction({ action: "send_text", args: { to: "351912345678", body: "hi" }, env, fetchImpl })
    ).rejects.toThrow();
    expect(cap.calls).toHaveLength(0);
  });

  it("send_text POSTs /send with the exact jid and body when given a valid jid", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    const cap = { calls: [] as any[] };
    const fetchImpl = mockFetch(cap, () => ({ json: { id: "wamid.1" } }));
    const result = await runAction({
      action: "send_text",
      args: { to: "351912345678@s.whatsapp.net", body: "On my way" },
      env,
      fetchImpl
    });
    expect(result).toEqual({ id: "wamid.1" });
    expect(cap.calls[0].url).toBe("http://127.0.0.1:9999/send");
    expect(cap.calls[0].opts.method).toBe("POST");
    expect(JSON.parse(cap.calls[0].opts.body)).toEqual({
      jid: "351912345678@s.whatsapp.net",
      body: "On my way"
    });
  });

  // Rule 2 of the brief: scheduled/unattended Automations runs must never be
  // able to send. GARRISON_AUTOMATION_ENGINE is set by the Automations
  // engine on every connector.mjs child it spawns (see
  // fittings/seed/automations/lib/engine.mjs defaultRunConnector).
  it("send_text refuses outright when GARRISON_AUTOMATION_ENGINE is set, even with a valid jid, before any network call", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir), GARRISON_AUTOMATION_ENGINE: "1" };
    const cap = { calls: [] as any[] };
    const fetchImpl = mockFetch(cap, () => ({ json: { id: "wamid.1" } }));
    await expect(
      runAction({
        action: "send_text",
        args: { to: "351912345678@s.whatsapp.net", body: "hi" },
        env,
        fetchImpl
      })
    ).rejects.toThrow(/Automations engine/);
    expect(cap.calls).toHaveLength(0);
  });

  it("recent_messages GETs /recent with the given n, defaulting to 20", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    const cap = { calls: [] as any[] };
    const fetchImpl = mockFetch(cap, () => ({ json: { messages: [] } }));
    await runAction({ action: "recent_messages", args: {}, env, fetchImpl });
    expect(cap.calls[0].url).toBe("http://127.0.0.1:9999/recent?n=20");
  });

  it("last_message GETs /last with the chat query", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    const cap = { calls: [] as any[] };
    const fetchImpl = mockFetch(cap, () => ({ json: { message: { body: "hi" } } }));
    const result = await runAction({ action: "last_message", args: { chat: "Maria" }, env, fetchImpl });
    expect(cap.calls[0].url).toBe("http://127.0.0.1:9999/last?chat=Maria");
    expect(result).toEqual({ message: { body: "hi" } });
  });

  it("surfaces a daemon-side awaiting_connector (e.g. not paired yet) on send_text", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    const fetchImpl = mockFetch({ calls: [] }, () => ({
      status: 409,
      json: { ok: false, error: "not connected", awaiting_connector: true }
    }));
    await expect(
      runAction({
        action: "send_text",
        args: { to: "351912345678@s.whatsapp.net", body: "hi" },
        env,
        fetchImpl
      })
    ).rejects.toMatchObject({ awaiting_connector: true });
  });

  it("rejects an unknown action", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-"));
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir) };
    await expect(runAction({ action: "nope", args: {}, env, fetchImpl: mockFetch({ calls: [] }, () => ({})) })).rejects.toThrow(
      /unknown action/
    );
  });
});
