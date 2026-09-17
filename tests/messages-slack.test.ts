import { describe, expect, it, vi } from "vitest";
import channels from "../test/fixtures/messages/slack/conversations.json";
import history from "../test/fixtures/messages/slack/history.json";
import replies from "../test/fixtures/messages/slack/replies.json";
import { createSlackActionAdapter, createSlackReadAdapter, createSlackSendAdapter, createSlackTransport,
  markdownToSlack, normalizeSlackMessage, slackDescriptor, slackFromProviderText, SLACK_MESSAGES_SCOPES } from "../packages/messages/providers/slack";
import type { OutboxItem } from "../packages/messages/types";

const now = () => new Date("2026-09-13T12:00:00Z");
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const names = { UCLIENT: "Client", UOWNER: "Owner" };
const fixtureFetch = vi.fn(async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("auth.test")) return response({ ok: true, user_id: "UOWNER", team_id: "TDEMO" });
  if (url.pathname.endsWith("users.list")) return response({ ok: true, members: Object.entries(names).map(([id, name]) => ({ id, name })), response_metadata: { next_cursor: "" } });
  if (url.pathname.endsWith("users.conversations")) return response(channels);
  if (url.pathname.endsWith("conversations.replies")) return response(replies);
  if (url.pathname.endsWith("conversations.history")) return response(url.searchParams.get("channel") === "CDEMO" ? history : { ok: true, messages: [] });
  return response({ ok: true });
}) as typeof fetch;
const item: OutboxItem = { id: "send-slack-1", provider: "slack", account: "TDEMO", to: { channel: "CDEMO" }, body: { markdown: "**Hello**" }, attachments: [], replyToExternalId: "CDEMO:1789300800.000100", origin: "user", holdUntil: now().toISOString(), status: "held", error: null };

describe("Messages Slack adapter", () => {
  it.each([
    ["**bold**", "*bold*"], ["*italic*", "_italic_"], ["~~gone~~", "~gone~"],
    ["`a * b`", "`a * b`"], ["[site](https://example.test)", "<https://example.test|site>"],
    ["```js\nconst a = 1;\n```", "```\nconst a = 1;\n```"], ["<script>bad</script>", "&lt;script&gt;bad&lt;/script&gt;"]
  ])("transforms Markdown %s to Slack", (input, expected) => { expect(markdownToSlack(input)).toBe(expected); });
  it("normalizes mentions, formatting and links without modifying code", () => {
    const result = slackFromProviderText("*Hello* _friend_ ~gone~ <@UOWNER> <https://example.test|site> `*literal*`", names);
    expect(result.markdown).toBe("**Hello** _friend_ ~~gone~~ @Owner [site](https://example.test) `*literal*`");
    expect(result.text).toContain("Hello friend gone @Owner site");
  });
  it("normalizes threads, own messages, attachments and reactions", () => {
    const root = normalizeSlackMessage(history.messages[0], channels.channels[0], "TDEMO", names, "UOWNER", now().toISOString());
    expect(root.message.reactions?.[0]).toMatchObject({ name: "eyes", count: 2 });
    expect(root.message.attachments[0]).toMatchObject({ kind: "image", externalRef: "FDEMO", width: 320 });
    const reply = normalizeSlackMessage(replies.messages[1], channels.channels[0], "TDEMO", names, "UOWNER", now().toISOString());
    expect(reply.conversation.kind).toBe("thread");
    expect(reply.conversation.parentConversationId).toBe(root.conversation.id);
    expect(reply.message.direction).toBe("out");
    expect(reply.message.read).toBe(true);
  });
  it("isolates identical timestamps across channels and accounts", () => {
    const one = normalizeSlackMessage(history.messages[0], { id: "CONE" }, "TONE").message;
    expect(normalizeSlackMessage(history.messages[0], { id: "CTWO" }, "TONE").message.id).not.toBe(one.id);
    expect(normalizeSlackMessage(history.messages[0], { id: "CONE" }, "TTWO").message.id).not.toBe(one.id);
  });
  it("discovers DMs, channels and threads while tracking per-conversation cursors", async () => {
    const adapter = createSlackReadAdapter({ token: "xoxp-fixture", fetchImpl: fixtureFetch, now });
    const result = await adapter.fetchMessages("TDEMO", null);
    expect(result.messages).toHaveLength(2);
    expect(result.cursor.channels.CDEMO).toBe("1789300800.000100");
    expect(result.cursor.threads["CDEMO:1789300800.000100"]).toBe("1789300801.000200");
    expect(result.conversations.some(c => c.kind === "thread")).toBe(true);
    expect(result.messages.find(m => m.direction === "in")?.sender.name).toBe("Client");
    const listed = await adapter.listConversations("TDEMO", null);
    expect(listed.find(c => c.kind === "dm")?.title).toBe("Owner");
  });
  it("continues polling known threads after their root falls behind the channel cursor", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      urls.push(String(url));
      if (String(url).includes("conversations.history")) return response({ ok: true, messages: [] });
      return fixtureFetch(url);
    }) as typeof fetch;
    await createSlackReadAdapter({ token: "xoxp-fixture", fetchImpl, now }).fetchMessages("TDEMO", { channels: { CDEMO: "1789300800.000100" }, threads: { "CDEMO:1789300800.000100": "1789300801.000200" } });
    expect(urls.some(value => { const url = new URL(value); return url.pathname.endsWith("conversations.replies") && Number(url.searchParams.get("oldest")) === Number("1789300801.000200"); })).toBe(true);
  });
  it("discovers a root's first reply after the root falls behind the saved channel cursor", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("conversations.history")) return response({ ok: true, messages: url.searchParams.has("latest") && url.searchParams.get("channel") === "CDEMO" ? history.messages : [] });
      return fixtureFetch(input);
    }) as typeof fetch;
    const result = await createSlackReadAdapter({ token: "xoxp-fixture", fetchImpl, now }).fetchMessages("TDEMO", { channels: { CDEMO: "1789300800.000100" }, threads: {} });
    expect(result.messages.some(message => message.externalId === "CDEMO:1789300801.000200")).toBe(true);
    expect(result.cursor.threads["CDEMO:1789300800.000100"]).toBe("1789300801.000200");
  });
  it("resumes a bounded root sweep across pages and retains completed work through Retry-After", async () => {
    const oldRoot = { ...history.messages[0], ts: "1700000000.000100", latest_reply: "1789300801.000200" };
    const sweepCursors: string[] = [];
    let blocked = true, current = now().getTime();
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("users.conversations")) return response({ ok: true, channels: [channels.channels[0]] });
      if (url.pathname.endsWith("conversations.history")) {
        if (!url.searchParams.has("latest")) return response({ ok: true, messages: [] });
        const scanCursor = url.searchParams.get("cursor") ?? "";
        sweepCursors.push(scanCursor);
        expect(url.searchParams.has("oldest")).toBe(false);
        if (!scanCursor) return response({ ok: true, messages: [{ ...oldRoot, reply_count: 0 }], response_metadata: { next_cursor: "page-two" } });
        if (blocked) return response({}, 429, { "retry-after": "7" });
        return response({ ok: true, messages: [oldRoot], response_metadata: { next_cursor: "" } });
      }
      if (url.pathname.endsWith("conversations.replies")) return response({ ok: true, messages: [oldRoot, { ...replies.messages[1], thread_ts: oldRoot.ts }] });
      return fixtureFetch(input);
    }) as typeof fetch;
    const adapter = createSlackReadAdapter({ token: "xoxp-fixture", fetchImpl, now: () => new Date(current), sleep: async ms => { current += ms; } });
    const first = await adapter.fetchMessages("TDEMO", { channels: { CDEMO: "1789300800.000100" } });
    expect(first.cursor.rootScans.CDEMO).toEqual({ latest: "1789300800.000100", cursor: "page-two" });
    expect(sweepCursors).toEqual([""]);
    const limited = await adapter.fetchMessages("TDEMO", first.cursor);
    expect(limited.retryAfterMs).toBe(7000);
    expect(limited.cursor.rootScans.CDEMO).toEqual(first.cursor.rootScans.CDEMO);
    blocked = false;
    const resumed = await adapter.fetchMessages("TDEMO", limited.cursor);
    expect(sweepCursors).toEqual(["", "page-two", "page-two", "page-two", "page-two"]);
    expect(resumed.cursor.rootScans.CDEMO).toBeUndefined();
    expect(resumed.messages.map(message => message.externalId)).toEqual(["CDEMO:1789300801.000200"]);
    expect(resumed.conversations.some(conversation => conversation.kind === "thread")).toBe(true);
    expect(resumed.cursor.channels.CDEMO).toBe("1789300800.000100");
  });
  it("retains the discovered root and reply queue when the replies request is rate limited", async () => {
    let blocked = true, current = now().getTime();
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("users.conversations")) return response({ ok: true, channels: [channels.channels[0]] });
      if (url.pathname.endsWith("conversations.history")) return response({ ok: true, messages: blocked ? history.messages : [] });
      if (url.pathname.endsWith("conversations.replies") && blocked) return response({}, 429, { "retry-after": "2" });
      return fixtureFetch(input);
    }) as typeof fetch;
    const adapter = createSlackReadAdapter({ token: "xoxp-fixture", fetchImpl, now: () => new Date(current), sleep: async ms => { current += ms; } });
    const limited = await adapter.fetchMessages("TDEMO", null);
    expect(limited.messages).toHaveLength(1);
    expect(limited.retryAfterMs).toBe(2000);
    expect(limited.cursor.pendingThreads).toEqual(["CDEMO:1789300800.000100"]);
    blocked = false;
    const resumed = await adapter.fetchMessages("TDEMO", limited.cursor);
    expect(resumed.messages.map(message => message.externalId)).toEqual(["CDEMO:1789300801.000200"]);
    expect(resumed.cursor.pendingThreads).toEqual([]);
  });
  it("drops a deleted thread from reconciliation without dropping other messages", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("conversations.replies")) return response({ ok: false, error: "thread_not_found" });
      return fixtureFetch(input);
    }) as typeof fetch;
    const result = await createSlackReadAdapter({ token: "xoxp-fixture", fetchImpl, now }).fetchMessages("TDEMO", null);
    expect(result.messages).toHaveLength(1);
    expect(result.cursor.pendingThreads).toEqual([]);
    expect(result.cursor.threads).toEqual({});
  });
  it("respects Retry-After and bounds rate-limit retries", async () => {
    let current = 0;
    const sleep = vi.fn(async (ms: number) => { current += ms; });
    const fetchImpl = vi.fn(async () => response({}, 429, { "retry-after": "3" })) as typeof fetch;
    const request = createSlackTransport({ token: "xoxp-fixture", fetchImpl, now: () => new Date(current), sleep });
    await expect(request("users.conversations")).rejects.toMatchObject({ status: 429, retryAfterMs: 3000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[3000], [3000]]);
  });
  it("does not allow a bot token to impersonate the user's inbox", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    expect(await createSlackReadAdapter({ token: "xoxb-fixture", fetchImpl }).health("TDEMO")).toMatchObject({ ok: false, reason: "Slack needs setup: reinstall Slack with user scopes" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("exposes no send or mutation method to ingest", () => {
    const read = createSlackReadAdapter({ token: "xoxp-fixture" });
    for (const key of ["send", "setRead", "delete", "vault", "exec"]) expect(read).not.toHaveProperty(key);
  });
  it("coalesces read actions by channel and keeps mark-unread local", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true })) as typeof fetch;
    const actions = createSlackActionAdapter({ token: "xoxp-fixture", fetchImpl });
    await actions.setRead("TDEMO", ["CDEMO:1.000100", "CDEMO:2.000200"], true);
    await actions.setRead("TDEMO", ["CDEMO:1.000100"], false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body))).toEqual({ channel: "CDEMO", ts: "2.000200" });
  });
  it("surfaces provider delete failures so optimistic state can roll back", async () => {
    const actions = createSlackActionAdapter({ token: "xoxp-fixture", fetchImpl: vi.fn(async () => response({ ok: false, error: "cant_delete_message" })) as typeof fetch });
    await expect(actions.delete("TDEMO", "CDEMO:1.000100")).rejects.toThrow("cant_delete_message");
  });
  it("sends replies with transformed text and an explicit thread timestamp", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true, ts: "1789300900.000100" })) as typeof fetch;
    expect(await createSlackSendAdapter({ token: "xoxp-fixture", fetchImpl }).send(item)).toEqual({ externalId: "CDEMO:1789300900.000100", conversationExternalId: "CDEMO" });
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body))).toMatchObject({ text: "*Hello*", thread_ts: "1789300800.000100" });
  });
  it("uploads files through the supported external upload flow", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      urls.push(String(url));
      if (String(url).includes("getUploadURLExternal")) return response({ ok: true, upload_url: "https://files.slack.com/upload/fixture", file_id: "FNEW" });
      if (String(url).includes("completeUploadExternal")) return response({ ok: true, files: [{ id: "FNEW", shares: { private: { CDEMO: [{ ts: "1789300900.000100" }] } } }] });
      return response({ ok: true });
    }) as typeof fetch;
    const send = createSlackSendAdapter({ token: "xoxp-fixture", fetchImpl, readFile: async () => new Uint8Array([1, 2]) });
    expect(await send.send({ ...item, attachments: [{ path: "file", name: "voice.m4a", mime: "audio/mp4" }] })).toMatchObject({ externalId: "CDEMO:1789300900.000100" });
    expect(urls).toHaveLength(3);
    expect(urls.some(url => url.includes("files.upload?"))).toBe(false);
  });
  it("uses Slack's returned self-DM channel for sent-message identity", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true, channel: "DSELF", ts: "1789300900.000100" })) as typeof fetch;
    const sent = await createSlackSendAdapter({ token: "xoxp-fixture", fetchImpl }).send({ ...item, to: { channel: "UOWNER" }, replyToExternalId: null });
    expect(sent).toEqual({ externalId: "DSELF:1789300900.000100", conversationExternalId: "DSELF" });
  });
  it("resolves a user recipient before completing a self-DM attachment upload", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith("conversations.open")) return response({ ok: true, channel: { id: "DSELF" } });
      if (String(url).includes("getUploadURLExternal")) return response({ ok: true, upload_url: "https://files.slack.com/upload/fixture", file_id: "FNEW" });
      if (String(url).includes("completeUploadExternal")) return response({ ok: true, files: [{ id: "FNEW", shares: { private: { DSELF: [{ ts: "1789300900.000100" }] } } }] });
      return response({ ok: true });
    }) as typeof fetch;
    const sent = await createSlackSendAdapter({ token: "xoxp-fixture", fetchImpl, readFile: async () => new Uint8Array([1]) }).send({ ...item, to: { channel: "UOWNER" }, replyToExternalId: null,
      attachments: [{ path: "fixture", name: "fixture.txt", mime: "text/plain" }] });
    expect(sent).toEqual({ externalId: "DSELF:1789300900.000100", conversationExternalId: "DSELF" });
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ users: "UOWNER" });
    expect(JSON.parse(String(calls[3][1]?.body)).channel_id).toBe("DSELF");
  });
  it("rejects private-file URLs outside Slack before sending the token", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true, file: { url_private: "https://attacker.example.test/file" } })) as typeof fetch;
    await expect(createSlackReadAdapter({ token: "xoxp-fixture", fetchImpl, writeFile: vi.fn() }).downloadAttachment("TDEMO", "FDEMO", "dest")).rejects.toThrow("unsupported attachment URL");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("declares read-cursor scopes and capability-driven archive behavior", () => {
    expect(SLACK_MESSAGES_SCOPES).toContain("channels:write");
    expect(slackDescriptor([]).capabilities.archive).toBe(false);
  });
});
