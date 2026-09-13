import { describe, expect, it, vi } from "vitest";
import { MessagesOfflineClient } from "../packages/messages/offline";

function setup(transport = vi.fn<any>(async () => ({ ok: true })), limits = {}) {
  const saved = new Map<string, string>(); let connected = false, sequence = 0;
  const client = new MessagesOfflineClient({ storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } },
    online: () => connected, id: () => `fixture-${++sequence}`, now: () => Date.parse("2026-09-13T12:00:00Z"), transport, ...limits });
  return { client, transport, saved, online() { connected = true; }, offline() { connected = false; } };
}
describe("Messages offline persistence", () => {
  it("queues explicit state and applies the final undo value when reconnected", async () => {
    const { client, transport, online } = setup();
    expect(await client.request("/message-one/state", { archived: true })).toMatchObject({ queued: true });
    await client.request("/message-one/state", { archived: false });
    await client.request("/message-one/state", { read: true });
    expect(client.pending()).toHaveLength(1); expect(transport).not.toHaveBeenCalled();
    online(); await client.flush();
    expect(transport).toHaveBeenCalledWith("/message-one/state", { archived: false, read: true }); expect(client.pending()).toEqual([]);
  });
  it("keeps one outbox id if the first response was lost after the server accepted it", async () => {
    const transport = vi.fn<any>().mockRejectedValueOnce(new TypeError("Network disconnected")).mockResolvedValue({ ok: true });
    const { client, online } = setup(transport); online();
    const queued: any = await client.request("/outbox", { provider: "fixture", account: "owner", to: { address: "self@example.test" }, body: { markdown: "Fixture" } });
    await client.flush();
    expect((transport.mock.calls[0][1] as any).id).toBe(queued.item.id);
    expect((transport.mock.calls[1][1] as any).id).toBe(queued.item.id);
    expect(client.pending()).toHaveLength(0);
  });
  it("serializes concurrent reconnect flushes", async () => {
    const { client, transport, online } = setup();
    await client.request("/one/state", { read: true }); await client.request("/two/state", { starred: true }); online();
    await Promise.all([client.flush(), client.flush(), client.flush()]); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("retains a transport failure for the next reconnect", async () => {
    const { client, online } = setup(vi.fn<any>().mockRejectedValue(new TypeError("Connection lost")));
    await client.request("/one/state", { read: true }); online(); await client.flush();
    expect(client.pending()).toHaveLength(1); expect(client.pending()[0].error).toBeUndefined();
  });
  it("retains an expired question error for a visible retry or discard", async () => {
    const { client, transport, online } = setup(vi.fn<any>().mockRejectedValue(Object.assign(new Error("Question already answered"), { status: 409 })));
    await client.request("/question-one/answer", { answer: "Approve" }); online(); await client.flush();
    expect(client.pending()[0].error).toBe("Question already answered");
    await client.flush(); expect(transport).toHaveBeenCalledTimes(1);
    client.discard(client.pending()[0].id); expect(client.pending()).toHaveLength(0);
  });
  it("uses the most recent stored list and conversation when offline", async () => {
    const { client, online, offline } = setup(vi.fn<any>(async (path: string) => ({ path, messages: [{ bodyText: "Fixture" }] })));
    online(); const list = await client.request("/conversations?filter=%7B%7D"), conversation = await client.request("/conversations/one"); offline();
    expect(await client.request("/conversations?filter=%7B%7D")).toEqual(list); expect(await client.request("/conversations/one")).toEqual(conversation);
  });
  it("bounds the queue and never reports unsaved actions as queued", async () => {
    const { client } = setup(undefined, { maxActions: 1 }); await client.request("/one/state", { read: true });
    await expect(client.request("/two/state", { read: true })).rejects.toThrow("queue is full");
    const storage = { getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); } };
    const full = new MessagesOfflineClient({ storage, transport: vi.fn(), online: () => false, id: () => "fixture" });
    await expect(full.request("/one/state", { read: true })).rejects.toThrow("could not save");
  });
  it("refuses arbitrary routes, provider writes and binaries in its queue", async () => {
    const { client } = setup();
    await expect(client.request("/providers/fixture/adapter/send", {})).rejects.toThrow("needs a connection");
    await expect(client.request("/one/state", { exec: "bad" })).rejects.toThrow("Invalid offline state");
    await expect(client.request("/upload", { base64: "bytes" })).rejects.toThrow("needs a connection");
    await expect(client.request("//evil.example", {})).rejects.toThrow("Invalid Messages route");
  });
  it("does not lose an action edited while its previous state was flushing", async () => {
    let finish!: () => void;
    const transport = vi.fn<any>(() => new Promise<void>(resolve => { finish = resolve; }));
    const { client, online, offline } = setup(transport);
    await client.request("/one/state", { read: true }); online(); const flushing = client.flush(); offline();
    await client.request("/one/state", { read: false }); finish(); await flushing;
    expect(client.pending()[0].body).toEqual({ read: false });
  });
  it("projects pending state onto cached lists, conversation messages and unread counts", async () => {
    const message = { id: "one", conversationId: "conversation", provider: "fixture", bodyText: "Fixture", read: false };
    const conversation = { id: "conversation", provider: "fixture", unreadCount: 2, lastMessage: message };
    const transport = vi.fn<any>(async (path: string) => path === "/providers" ? { providers: [{ id: "fixture", kind: "mail" }] } : path === "/counts" ? { counts: { all: 2, mail: 2 } } : path === "/conversations/conversation" ? { conversation, messages: [message] } : { conversations: [conversation] });
    const { client, online, offline } = setup(transport); online();
    for (const path of ["/providers", "/counts", "/conversations", "/conversations/conversation"]) await client.request(path);
    offline(); await client.request("/conversations/conversation/state", { read: true });
    expect(await client.request("/counts")).toEqual({ counts: { all: 0, mail: 0 } });
    expect(await client.request("/conversations")).toMatchObject({ conversations: [{ unreadCount: 0, pending: true }] });
    expect(await client.request("/conversations/conversation")).toMatchObject({ messages: [{ read: true, pending: true }] });
    await client.request("/conversations/conversation/state", { deleted: true }); expect(await client.request("/conversations")).toEqual({ conversations: [] });
    await client.request("/conversations/conversation/state", { deleted: false }); expect((await client.request<any>("/conversations")).conversations).toHaveLength(1);
  });
});
