import { marked, type Token } from "marked";
import type { Conversation, Message, OutboxItem, ProviderDescriptor } from "../types";
import { attachmentId, baseAttachment, baseConversation, baseMessage, participant, ProviderHttpError,
  providerId, safeHttpsUrl, type Account, type JsonRecord, type SendOptions, type TransportOptions } from "./shared";

import { normalizeSlackMessage, slackFromProviderText, markdownToSlack, externalParts, type SlackOptions, type SlackCursor } from "./slack-common";
export function createSlackReadTransport(options: SlackOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = () => (options.now?.() ?? new Date()).getTime();
  let blockedUntil = 0;
  return async function request(method: string, args: JsonRecord = {}): Promise<JsonRecord> {
    if (!["auth.test", "users.list", "users.conversations", "conversations.history", "conversations.replies", "files.info"].includes(method)) throw new Error("Unsupported Slack read endpoint");
    const mutates = false;
    if (!options.token.startsWith("xoxp-")) throw new Error("Slack needs setup: reinstall Slack with user scopes");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (blockedUntil > now()) await sleep(blockedUntil - now());
      const query = new URLSearchParams(Object.entries(args).filter(([,v]) => v !== undefined && v !== null).map(([k,v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]));
      const response = await fetchImpl(`https://slack.com/api/${method}${mutates ? "" : `?${query}`}`, {
        method: mutates ? "POST" : "GET",
        headers: { authorization: `Bearer ${options.token}`, ...(mutates ? { "content-type": "application/json; charset=utf-8" } : {}) },
        ...(mutates ? { body: JSON.stringify(args) } : {}), signal: AbortSignal.timeout(30_000)
      });
      if (response.status === 429) {
        const retry = Math.max(1000, Number(response.headers.get("retry-after") || 60) * 1000);
        blockedUntil = now() + retry;
        if (attempt < 2) continue;
        throw new ProviderHttpError(429, "Slack rate limited", retry);
      }
      if (!response.ok) throw new ProviderHttpError(response.status, "Slack request failed");
      const body = await response.json();
      if (!body.ok) throw new ProviderHttpError(400, `Slack ${String(body.error ?? "request_failed").replace(/[^a-z_]/g, "")}`);
      return body;
    }
    throw new Error("Slack request failed");
  };
}
export function createSlackReadAdapter(options: SlackOptions) {
  const request = createSlackReadTransport(options);
  const names: Record<string, string> = {};
  let ownUserId = options.ownUserId ?? "";
  let usersLoaded = false;
  async function users() {
    if (usersLoaded) return;
    if (!ownUserId) ownUserId = String((await request("auth.test")).user_id);
    let cursor = "";
    do {
      const page = await request("users.list", { limit: 200, cursor });
      for (const user of page.members ?? []) names[user.id] = user.profile?.display_name || user.real_name || user.name || user.id;
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);
    usersLoaded = true;
  }
  async function channels(): Promise<JsonRecord[]> {
    const all: JsonRecord[] = [];
    let cursor = "";
    do {
      const page = await request("users.conversations", { types: "public_channel,private_channel,mpim,im", limit: 200, cursor, exclude_archived: false });
      all.push(...(page.channels ?? []));
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return all;
  }
  async function messagePages(method: string, args: JsonRecord): Promise<JsonRecord[]> {
    const all: JsonRecord[] = [];
    let cursor = "";
    let more = false;
    do {
      const page = await request(method, { ...args, limit: 100, cursor });
      all.push(...(page.messages ?? []));
      const nextCursor = page.response_metadata?.next_cursor ?? "";
      if (page.has_more && !nextCursor) {
        // Slack also supports timestamp pagination when a cursor is absent.
        const last = page.messages?.at(-1)?.ts;
        const boundary = method === "conversations.replies" ? "oldest" : "latest";
        if (!last || last === args[boundary]) throw new Error("Slack pagination did not advance");
        args = { ...args, [boundary]: last, inclusive: false };
        cursor = "";
        more = true;
      } else { cursor = nextCursor; more = Boolean(cursor); }
    } while (more);
    return all;
  }
  return {
    async listConversations(account: string, _since: string | null) {
      await users();
      return (await channels()).map(channel => {
        const conversation = baseConversation("slack", account, channel.id, channel.is_im ? "dm" : channel.is_mpim ? "group" : "channel", channel.name || names[channel.user] || channel.user || channel.id,
          new Date(Number(channel.latest?.ts ?? channel.created ?? 0) * 1000).toISOString());
        conversation.archived = !!channel.is_archived;
        conversation.unreadCount = Number(channel.unread_count ?? 0);
        return conversation;
      });
    },
    async fetchMessages(account: string, previous: SlackCursor | null) {
      await users();
      const cursor: Required<SlackCursor> = { ...previous, channels: { ...previous?.channels }, threads: { ...previous?.threads },
        rootScans: { ...previous?.rootScans }, rootIndex: previous?.rootIndex ?? 0,
        pendingThreads: [...(previous?.pendingThreads?.length ? previous.pendingThreads : Object.keys(previous?.threads ?? {}))] };
      const messages = new Map<string, Message>(), conversations = new Map<string, Conversation>();
      const now = options.now?.() ?? new Date();
      const availableChannels = await channels();
      const rootChannel = availableChannels[cursor.rootIndex % Math.max(1, availableChannels.length)]?.id;
      let retryAfterMs = 0, threadBudget = 5;
      for (const channel of availableChannels) {
        const retainedSince = String(Math.floor(now.getTime() / 1000) - Math.max(1, options.retentionDays ?? 90) * 86400);
        const previousLatest = cursor.channels[channel.id];
        const rawMessages = await messagePages("conversations.history", { channel: channel.id, oldest: previousLatest ?? retainedSince, inclusive: false });
        // One resumable old-root page per account tick finds late replies without an age exception.
        if (channel.id === rootChannel) {
          const scan = cursor.rootScans[channel.id] ?? { latest: previousLatest ?? retainedSince };
          try {
            const page = await request("conversations.history", { channel: channel.id, latest: scan.latest, cursor: scan.cursor, inclusive: true, limit: 100 });
            rawMessages.push(...(page.messages ?? []));
            const next = page.response_metadata?.next_cursor;
            if (next) cursor.rootScans[channel.id] = { ...scan, cursor: next };
            else if (page.has_more && page.messages?.length) cursor.rootScans[channel.id] = { latest: String(page.messages.at(-1).ts) };
            else delete cursor.rootScans[channel.id];
            cursor.rootIndex = (cursor.rootIndex + 1) % Math.max(1, availableChannels.length);
          } catch (error) {
            if (!(error instanceof ProviderHttpError) || error.status !== 429) throw error;
            retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs || 60_000);
          }
        }
        let latest = cursor.channels[channel.id] ?? "0";
        for (const raw of rawMessages) {
          if (Number(raw.ts) > Number(latest)) latest = String(raw.ts);
          if (raw.reply_count > 0) {
            const thread = `${channel.id}:${raw.ts}`;
            cursor.threads[thread] ??= "0";
            if ((!raw.latest_reply || Number(raw.latest_reply) > Number(cursor.threads[thread])) && !cursor.pendingThreads.includes(thread)) cursor.pendingThreads.push(thread);
          }
        }
        for (const thread of [...cursor.pendingThreads]) {
          if (!thread.startsWith(`${channel.id}:`)) continue;
          if (threadBudget-- <= 0 || retryAfterMs) break;
          const lastReply = cursor.threads[thread] ?? "0";
          const rootTs = thread.slice(channel.id.length + 1);
          const root = rawMessages.find(raw => raw.ts === rootTs);
          if (root?.latest_reply && Number(root.latest_reply) <= Number(lastReply)) { cursor.pendingThreads = cursor.pendingThreads.filter(value => value !== thread); continue; }
          try {
            const page = await request("conversations.replies", { channel: channel.id, ts: rootTs, oldest: String(Math.max(Number(lastReply), Number(retainedSince))), inclusive: false, limit: 100 });
            const replies: JsonRecord[] = page.messages ?? [];
            rawMessages.push(...replies.filter(raw => raw.ts !== rootTs));
            cursor.threads[thread] = replies.reduce((max, raw) => Number(raw.ts) > Number(max) ? String(raw.ts) : max, lastReply);
            if (!page.has_more && !page.response_metadata?.next_cursor) cursor.pendingThreads = cursor.pendingThreads.filter(value => value !== thread);
          } catch (error) {
            if (error instanceof ProviderHttpError && /thread_not_found/.test(error.message)) {
              delete cursor.threads[thread]; cursor.pendingThreads = cursor.pendingThreads.filter(value => value !== thread); continue;
            }
            if (!(error instanceof ProviderHttpError) || error.status !== 429) throw error;
            retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs || 60_000);
          }
        }
        for (const raw of rawMessages) {
          if (!raw.ts || raw.subtype === "message_deleted" || Number(raw.ts) < Number(retainedSince)) continue;
          const normalized = normalizeSlackMessage(raw.message ?? raw, channel, account, names, ownUserId, now.toISOString());
          messages.set(normalized.message.id, normalized.message);
          for (const conversation of [normalized.parent, normalized.conversation]) {
            const existing = conversations.get(conversation.id);
            if (!existing || conversation.lastMessageTs > existing.lastMessageTs) conversations.set(conversation.id, conversation);
          }
        }
        cursor.channels[channel.id] = latest;
        if (retryAfterMs) break;
      }
      return { messages: [...messages.values()], conversations: [...conversations.values()], cursor, ...(retryAfterMs ? { retryAfterMs } : {}) };
    },
    async downloadAttachment(_account: string, ref: string, destination: string) {
      if (!options.writeFile) throw new Error("Attachment storage is unavailable");
      const response = await request("files.info", { file: ref });
      const file = response.file;
      const url = safeHttpsUrl(file?.url_private_download ?? file?.url_private ?? "", ["slack.com", "slack-edge.com"]);
      const downloaded = await (options.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${options.token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!downloaded.ok) throw new ProviderHttpError(downloaded.status, "Slack attachment download failed");
      const bytes = new Uint8Array(await downloaded.arrayBuffer());
      await options.writeFile(destination, bytes);
      return { mime: String(file.mimetype ?? "application/octet-stream"), size: bytes.byteLength };
    },
    fromProviderText(raw: unknown) { return slackFromProviderText(raw, names); },
    async health(_account: string) {
      try { await request("auth.test"); await request("users.conversations", { types: "im", limit: 1 }); return { ok: true }; }
      catch (error) { return { ok: false, reason: (error as Error).message }; }
    }
  };
}
