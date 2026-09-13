import { describe, expect, it, vi } from "vitest";
import raw from "../test/fixtures/messages/google/message.json";
import history from "../test/fixtures/messages/google/history.json";
import { buildGoogleMime, createGoogleActionAdapter, createGoogleReadAdapter, createGoogleSendAdapter,
  googleDescriptor, markdownToMail, normalizeGoogleMessage, parseMailParticipants } from "../packages/messages/providers/google";
import { sanitizeMailHtml } from "../packages/messages/providers/mail-html";
import type { OutboxItem } from "../packages/messages/types";

const now = () => new Date("2026-09-13T12:00:00Z");
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const item: OutboxItem = { id: "mail-send", provider: "google", account: "owner@example.test", to: { address: "owner@example.test", subject: "Smoke" },
  body: { markdown: "**Hello**\n\n```js\nconst a = 1;\n```" }, attachments: [], replyToExternalId: null, origin: "user", holdUntil: now().toISOString(), status: "held", error: null };

describe("Messages Google adapter", () => {
  it("lists existing label ids and names without fetching message content", async () => {
    const fetchImpl = vi.fn(async () => response({ labels: [{ id: "Label_1", name: "Clients", type: "user" }, { id: "INBOX", name: "Inbox", type: "system" }, { id: "malformed" }] })) as typeof fetch;
    const labels = await createGoogleReadAdapter({ token: "fixture", fetchImpl }).listLabels();
    expect(labels).toEqual([{ id: "Label_1", name: "Clients", type: "user" }, { id: "INBOX", name: "Inbox", type: "system" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    expect(vi.mocked(fetchImpl).mock.calls[0][1]?.method).toBe("GET");
  });
  it("normalizes one record including labels, sender, recipient and attachment reference", () => {
    const { message, conversation } = normalizeGoogleMessage(raw, "owner", "owner@example.test", now().toISOString());
    expect(message).toMatchObject({ externalId: "mail-001", bodyText: "A fixture project update.", read: false, archived: false, starred: true, direction: "in" });
    expect(message.recipients[0].isMe).toBe(true);
    expect(message.attachments[0]).toMatchObject({ kind: "image", externalRef: "mail-001/att-001", path: null });
    expect(message.conversationId).toBe(conversation.id);
    expect(message.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("keeps provider/account/id identities stable and isolated", () => {
    const a = normalizeGoogleMessage(raw, "a").message;
    expect(normalizeGoogleMessage(raw, "a").message.id).toBe(a.id);
    expect(normalizeGoogleMessage(raw, "b").message.id).not.toBe(a.id);
  });
  it("parses quoted display names containing commas", () => {
    expect(parseMailParticipants('"Client, Example" <client@example.test>, owner@example.test', "owner@example.test")).toMatchObject([
      { name: "Client, Example", address: "client@example.test" }, { isMe: true }
    ]);
  });
  it("maps provider read, archive, trash and sent labels", () => {
    const { message } = normalizeGoogleMessage({ ...raw, labelIds: ["TRASH", "SENT"] }, "owner");
    expect(message).toMatchObject({ read: true, archived: true, deleted: true, starred: false, direction: "out" });
  });
  it("captures the history checkpoint before initial backfill and fetches every page", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const value = String(url); urls.push(value);
      if (value.endsWith("/profile")) return response({ historyId: "100" });
      if (value.includes("/messages?")) return response(value.includes("pageToken") ? { messages: [] } : { messages: [{ id: raw.id }], nextPageToken: "page2" });
      return response(raw);
    }) as typeof fetch;
    const result = await createGoogleReadAdapter({ token: "fixture", fetchImpl, now }).fetchMessages("owner", null);
    expect(urls[0]).toMatch(/\/profile$/);
    expect(result.messages).toHaveLength(1);
    expect(result.cursor.historyId).toBe("100");
    expect(urls.filter(url => url.includes("messages?"))).toHaveLength(2);
  });
  it("replays history without duplicate fetches and exposes permanent deletions separately", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => response(String(url).includes("/history?") ? history : { ...raw, labelIds: ["INBOX"] })) as typeof fetch;
    const result = await createGoogleReadAdapter({ token: "fixture", fetchImpl, now }).fetchMessages("owner", { historyId: "100" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].read).toBe(true);
    expect(result.deletedExternalIds).toEqual(["mail-deleted"]);
    expect(result.cursor.historyId).toBe("103");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not advance the checkpoint after an interrupted message fetch", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => String(url).includes("/history?") ? response(history) : response({}, 503)) as typeof fetch;
    await expect(createGoogleReadAdapter({ token: "fixture", fetchImpl, now }).fetchMessages("owner", { historyId: "100" })).rejects.toThrow("503");
  });
  it("falls back to full sync only for an expired history checkpoint", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).includes("history?")) return response({}, 404);
      if (String(url).endsWith("profile")) return response({ historyId: "200" });
      return response({ messages: [] });
    }) as typeof fetch;
    expect((await createGoogleReadAdapter({ token: "fixture", fetchImpl }).fetchMessages("owner", { historyId: "old" })).cursor.historyId).toBe("200");
  });
  it("downloads lazy attachment data through a confined storage callback", async () => {
    const writeFile = vi.fn();
    const adapter = createGoogleReadAdapter({ token: "fixture", fetchImpl: vi.fn(async () => response({ data: "aGVsbG8" })) as typeof fetch, writeFile });
    expect(await adapter.downloadAttachment("owner", "mail-001/att-001", "fixture-path")).toMatchObject({ size: 5 });
    expect(Buffer.from(writeFile.mock.calls[0][1]).toString()).toBe("hello");
  });
  it("read adapter never exposes send, provider mutation or credential resolution", () => {
    const adapter = createGoogleReadAdapter({ token: "fixture" });
    expect(Object.keys(adapter)).not.toEqual(expect.arrayContaining(["send"]));
    for (const key of ["send", "setRead", "archive", "delete", "vault", "exec"]) expect(adapter).not.toHaveProperty(key);
  });
  it("updates read, star, labels, archive and trash through provider endpoints", async () => {
    const fetchImpl = vi.fn(async () => response({})) as typeof fetch;
    const adapter = createGoogleActionAdapter({ token: "fixture", fetchImpl });
    await adapter.setRead("owner", ["a"], true);
    await adapter.setStarred("owner", ["a"], true);
    await adapter.setLabels("owner", ["a"], ["Clients"]);
    await adapter.archive("owner", "thread");
    await adapter.delete("owner", "a");
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ ids: ["a"], addLabelIds: [], removeLabelIds: ["UNREAD"] });
    expect(String(calls[3][0])).toContain("threads/thread/modify");
    expect(String(calls[4][0])).toContain("messages/a/trash");
  });
  it("sanitizes scripts, forms, CSS fetches and remote images", () => {
    const clean = sanitizeMailHtml('<script>alert(1)</script><form><input value="secret"></form><p style="background:url(https://tracker.test/a)">Hello</p><img src="https://tracker.test/pixel"><img srcset="https://tracker.test/2"><a href="javascript:alert(1)">bad</a>');
    expect(clean.html).not.toMatch(/script|form|input|style=|src=|srcset|javascript:/);
    expect(clean.remoteImages).toEqual(["https://tracker.test/pixel"]);
    expect(clean.html).toContain("Hello");
  });
  it("loads remote images only on explicit request and hardens links", () => {
    const clean = sanitizeMailHtml('<img src="https://images.example.test/1"><a href="https://example.test">Open</a>', true);
    expect(clean.html).toContain('src="https://images.example.test/1"');
    expect(clean.html).toContain('rel="noopener noreferrer"');
  });
  it("renders fenced Markdown as HTML and preserves plain text", () => {
    const content = markdownToMail(item.body.markdown);
    expect(content.html).toContain("<strong>Hello</strong>");
    expect(content.html).toContain("<pre><code");
    expect(content.text).toBe(item.body.markdown);
  });
  it("builds multipart mail and resists MIME header injection", async () => {
    const mime = await buildGoogleMime({ ...item, to: { address: "owner@example.test\r\nBcc: injected@example.test", subject: "safe\r\nInjected: bad" }, attachments: [{ path: "a", name: 'a".png', mime: "image/png" }] }, async () => new Uint8Array([1, 2]));
    expect(mime).toContain("multipart/alternative");
    expect(mime).not.toContain("\r\nBcc:");
    expect(mime).not.toContain("\r\nInjected:");
    expect(mime).toContain("Content-Disposition: attachment");
  });
  it("sends only a structured outbox object", async () => {
    const fetchImpl = vi.fn(async () => response({ id: "sent-1" })) as typeof fetch;
    expect(await createGoogleSendAdapter({ token: "fixture", fetchImpl }).send(item)).toMatchObject({ externalId: "sent-1" });
    const payload = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body));
    expect(Buffer.from(payload.raw, "base64url").toString()).toContain("To: owner@example.test");
  });
  it("registers all accounts without hard-coding mailbox identities", () => {
    expect(googleDescriptor([{ id: "a", label: "A" }, { id: "b", label: "B" }]).accounts).toHaveLength(2);
  });
});
