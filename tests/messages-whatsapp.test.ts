import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../test/fixtures/messages/whatsapp-web/events.json";
import { normalizeWhatsAppMessage, WhatsAppMessagesStore, createWhatsAppMessagesAdapter, whatsappDescriptor,
  whatsappFromProviderText, whatsappToProviderText } from "../fittings/seed/whatsapp-web/lib/messages.mjs";
import { Outbox, OUTBOUND_DELAY_SECONDS } from "../fittings/seed/whatsapp-web/lib/outbox.mjs";
import { buildConnectionManager, createOutboxSender, createApp } from "../fittings/seed/whatsapp-web/scripts/server.mjs";

const time = Date.parse("2026-09-13T12:00:05Z");
const now = () => time;
const account = "100@s.whatsapp.net";
const dirs: string[] = [];
const temp = () => { const directory = mkdtempSync(path.join(os.tmpdir(), "messages-wa-")); dirs.push(directory); return directory; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const normalize = (raw: unknown) => normalizeWhatsAppMessage(raw, { account, now, group: fixtures.group, contactName: (jid: string) => jid === account ? "Owner" : "Client" });

function adapterFixture() {
  const root = temp();
  const store = new WhatsAppMessagesStore(root, { now });
  for (const raw of fixtures.messages) store.append(raw, normalize(raw));
  const connectionManager = { status: () => ({ connected: true }), sendText: vi.fn(async () => ({ id: "sent" })),
    sendMedia: vi.fn(async () => ({ id: "sent-media" })), readMessages: vi.fn(), deleteMessage: vi.fn(),
    downloadMedia: vi.fn(async () => Buffer.from([1, 2, 3])) };
  const outbox = new Outbox({ file: path.join(root, "outbox.json"), send: createOutboxSender(connectionManager), now, setTimer: () => 0, clearTimer: () => {} });
  const adapter = createWhatsAppMessagesAdapter({ connectionManager, messagesStore: store, outbox, root, now });
  return { root, store, connectionManager, outbox, adapter };
}
describe("Messages WhatsApp adapter", () => {
  it("keeps photos and voice notes without captions as ordinary messages", () => {
    const image = normalize(fixtures.messages[0]);
    const audio = normalize(fixtures.messages[1]);
    expect(image.message.attachments[0]).toMatchObject({ kind: "image", width: 640, height: 480 });
    expect(audio.message.attachments[0]).toMatchObject({ kind: "audio", durationMs: 3000, transcriptStatus: "pending" });
    expect(audio.message.bodyText).toBe("");
  });
  it("maps group title and all participants", () => {
    const normalized = normalize(fixtures.messages[0]);
    expect(normalized.conversation).toMatchObject({ kind: "group", title: "Fixture project" });
    expect(normalized.conversation.participants).toEqual([{ id: account, name: "Owner", isMe: true }, { id: "200@s.whatsapp.net", name: "Client", isMe: false }]);
    expect(normalized.message.sender.name).toBe("Example Client");
  });
  it("uses stable ids, separates accounts, and keeps raw binary metadata out of normalized records", () => {
    const raw = { ...fixtures.messages[0], message: { imageMessage: { ...fixtures.messages[0].message.imageMessage, jpegThumbnail: Buffer.from("secret-provider-data") } } };
    const normalized = normalize(raw);
    expect(normalize(raw).message.id).toBe(normalized.message.id);
    expect(normalizeWhatsAppMessage(raw, { account: "other", now }).message.id).not.toBe(normalized.message.id);
    expect(JSON.stringify(normalized)).not.toContain("secret-provider-data");
    expect(JSON.stringify(normalized)).not.toContain("jpegThumbnail");
  });
  it("deduplicates resyncs and reconciles records after fitting restart", () => {
    const root = temp();
    const store = new WhatsAppMessagesStore(root, { now });
    expect(store.append(fixtures.messages[0], normalize(fixtures.messages[0]))).toBe(true);
    expect(store.append(fixtures.messages[0], normalize(fixtures.messages[0]))).toBe(false);
    const restored = new WhatsAppMessagesStore(root, { now });
    expect(restored.fetch(account).messages).toHaveLength(1);
    expect(restored.raw(restored.fetch(account).messages[0].externalId).key.id).toBe("WAIMAGE1");
  });
  it("preserves incremental updates at equal timestamp boundaries", () => {
    const { store } = adapterFixture();
    expect(store.fetch(account, { receivedTs: new Date(time).toISOString() }).messages).toHaveLength(3);
    expect(store.fetch("other").messages).toHaveLength(0);
  });
  it("exposes relative raw paths across the mesh while keeping owner disk reads local", () => {
    const { store, root } = adapterFixture();
    const message = store.fetch(account).messages[0];
    expect(message.rawPath).toMatch(/^raw\/whatsapp-web\//);
    expect(message.rawPath).not.toContain(root);
    expect(store.get(message.externalId).message.rawPath).toContain(root);
    expect(store.raw(message.externalId).key.id).toBe("WAIMAGE1");
  });
  it("allows token-free ingest reads and requires broker authorization for writes", async () => {
    const calls: string[] = [];
    const handler = createApp({ connectionManager: {} as any, store: {} as any, contactIndex: {} as any, port: 0, host: "127.0.0.1",
      messagesAdapter: { fetchMessages: async () => { calls.push("fetchMessages"); return { messages: [] }; }, send: async () => { calls.push("send"); return { externalId: "sent" }; } },
      verifyMessagesWrite: async (request: any) => request.headers["x-garrison-internal"] === "fixture-internal" });
    async function request(method: string, authorized = false) {
      const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", url: `/messages-adapter/${method}`, socket: { remoteAddress: "127.0.0.1" }, headers: authorized ? { "x-garrison-internal": "fixture-internal" } : {} });
      const res = { statusCode: 0, setHeader: () => {}, end: () => {} };
      await handler(req as any, res as any);
      return res.statusCode;
    }
    expect(await request("fetchMessages")).toBe(200);
    expect(await request("send")).toBe(403);
    expect(calls).toEqual(["fetchMessages"]);
    expect(await request("send", true)).toBe(200);
    expect(calls).toEqual(["fetchMessages", "send"]);
  });
  it("does not expose ephemeral status broadcasts", () => {
    expect(normalize({ ...fixtures.messages[0], key: { id: "STATUS", remoteJid: "status@broadcast" } })).toBeNull();
  });
  it("preserves the existing exact sixty second agent hold and cancellation", async () => {
    const { adapter, connectionManager, outbox } = adapterFixture();
    const queued = await adapter.send({ item: { id: "outer", origin: "agent", to: { jid: "200@s.whatsapp.net" }, body: { markdown: "Hello" }, attachments: [] } });
    expect(OUTBOUND_DELAY_SECONDS).toBe(60);
    expect(Date.parse(queued.executeAt) - time).toBe(60_000);
    expect(connectionManager.sendMedia).not.toHaveBeenCalled();
    expect(outbox.get(queued.id)?.context).toBe("agent");
    expect(adapter.cancelSend({ id: queued.id }).status).toBe("cancelled");
    await outbox.fire(queued.id);
    expect(connectionManager.sendMedia).not.toHaveBeenCalled();
  });
  it("does not double-enqueue the same Messages outbox item", async () => {
    const { adapter, outbox } = adapterFixture();
    const item = { id: "stable", origin: "agent", to: { jid: "200@s.whatsapp.net" }, body: { markdown: "Hello" }, attachments: [] };
    expect((await adapter.send({ item })).id).toBe((await adapter.send({ item })).id);
    expect(outbox.pending()).toHaveLength(1);
  });
  it("sends an explicit user action immediately through the same pacing entrypoint", async () => {
    const { adapter, connectionManager } = adapterFixture();
    expect(await adapter.send({ item: { id: "user", origin: "user", to: { jid: "200@s.whatsapp.net" }, body: { markdown: "**Hello**" }, attachments: [] } })).toMatchObject({ externalId: "200@s.whatsapp.net:sent-media" });
    expect(connectionManager.sendMedia).toHaveBeenCalledWith("200@s.whatsapp.net", "*Hello*", []);
  });
  it("reports the eventual send result from the delegated outbox", async () => {
    const { adapter, outbox } = adapterFixture();
    const queued = await adapter.send({ item: { id: "agent", origin: "agent", to: { jid: "200@s.whatsapp.net" }, body: { markdown: "Hello" }, attachments: [] } });
    await outbox.fire(queued.id);
    expect(adapter.outboxStatus({ id: queued.id })).toMatchObject({ status: "sent", externalId: "200@s.whatsapp.net:sent-media" });
  });
  it("honors the per-account read-receipt setting", async () => {
    const { adapter, connectionManager, store } = adapterFixture();
    const id = store.fetch(account).messages[0].externalId;
    await adapter.setRead({ account, messageExternalIds: [id], read: true, sendReadReceipts: false });
    expect(connectionManager.readMessages).not.toHaveBeenCalled();
    await adapter.setRead({ account, messageExternalIds: [id], read: true });
    expect(connectionManager.readMessages).toHaveBeenCalledWith([fixtures.messages[0].key]);
  });
  it("permits provider delete only for recent own messages", async () => {
    const { adapter, connectionManager, store } = adapterFixture();
    const messages = store.fetch(account).messages;
    await expect(adapter.delete({ account, messageExternalId: messages[0].externalId })).rejects.toThrow("Only your own");
    await adapter.delete({ account, messageExternalId: messages[2].externalId });
    expect(connectionManager.deleteMessage).toHaveBeenCalledWith(fixtures.messages[2].key);
  });
  it("downloads media only inside Messages attachment storage", async () => {
    const { adapter, root, store } = adapterFixture();
    const ref = store.fetch(account).messages[0].externalId;
    expect(await adapter.downloadAttachment({ account, ref, dest: path.join(root, "attachments", "whatsapp-web", "image.jpg") })).toMatchObject({ size: 3, mime: "image/jpeg" });
    await expect(adapter.downloadAttachment({ account, ref, dest: path.join(root, "..", "outside.jpg") })).rejects.toThrow("outside Messages");
  });
  it("rejects attachment paths that traverse symlinks", async () => {
    const { adapter, root } = adapterFixture();
    const outside = temp();
    mkdirSync(path.join(root, "attachments"));
    symlinkSync(outside, path.join(root, "attachments", "escape"));
    await expect(adapter.send({ item: { id: "escape", origin: "user", to: { jid: "200@s.whatsapp.net" }, body: { markdown: "" }, attachments: [{ path: path.join(root, "attachments", "escape", "secret"), name: "secret", mime: "text/plain" }] } })).rejects.toThrow("symlink");
  });
  it("normalizes formatting while preserving fenced code", () => {
    expect(whatsappToProviderText("**bold** ~~gone~~\n```js\na ** b\n```" )).toBe("*bold* ~gone~\n```\na ** b\n```");
    expect(whatsappFromProviderText("*bold* ~gone~ ```a * b``` ").markdown).toBe("**bold** ~~gone~~ ```a * b``` ");
  });
  it("advertises the actual pairing readiness and delegated hold", () => {
    expect(whatsappDescriptor(account, false)).toMatchObject({ setupHint: "Pair WhatsApp in its fitting", holdSeconds: 60, managesAgentHold: true });
  });
  it("keeps newly registered inbound bodies out of the legacy gateway prompt path", async () => {
    const root = temp();
    mkdirSync(path.join(root, "auth")); writeFileSync(path.join(root, "auth", "creds.json"), "{}");
    const handlers = new Map<string, (value: any) => void>();
    const socket = { user: { id: account }, ev: { on: (name: string, handler: (value: any) => void) => handlers.set(name, handler) }, profilePictureUrl: async () => null };
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const received = vi.fn();
    const manager = buildConnectionManager({ sessionDir: root, gatewayUrl: "http://fixture.invalid", store: { append() {} }, contactIndex: { byJid: new Map(), upsert() {} },
      sendQueue: { enqueue: (task: () => unknown) => task() }, messagesEnabled: () => true, onMessagesRecord: received, fetchImpl,
      baileysModuleLoader: async () => ({ default: () => socket, useMultiFileAuthState: async () => ({ state: { creds: { registered: true } }, saveCreds() {} }), fetchLatestBaileysVersion: async () => ({ version: [1] }) }) });
    await manager.init();
    handlers.get("messages.upsert")?.({ messages: [fixtures.messages[0], fixtures.messages[1]] });
    await Promise.resolve();
    expect(received).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
