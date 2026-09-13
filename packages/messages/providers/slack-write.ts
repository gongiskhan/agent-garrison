import { marked, type Token } from "marked";
import type { Conversation, Message, OutboxItem, ProviderDescriptor } from "../types";
import { attachmentId, baseAttachment, baseConversation, baseMessage, participant, ProviderHttpError,
  providerId, safeHttpsUrl, type Account, type JsonRecord, type SendOptions, type TransportOptions } from "./shared";

import { normalizeSlackMessage, slackFromProviderText, markdownToSlack, externalParts, type SlackOptions, type SlackCursor } from "./slack-common";
export function createSlackTransport(options: SlackOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = () => (options.now?.() ?? new Date()).getTime();
  let blockedUntil = 0;
  return async function request(method: string, args: JsonRecord = {}, mutates = false): Promise<JsonRecord> {
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
export function createSlackActionAdapter(options: SlackOptions) {
  const request = createSlackTransport(options);
  return {
    async setRead(_account: string, ids: string[], read: boolean) {
      if (!read) return; // Mark unread is local because Slack exposes a forward read cursor.
      const newest = new Map<string, string>();
      for (const id of ids) { const { channel, ts } = externalParts(id); if (Number(ts) > Number(newest.get(channel) ?? 0)) newest.set(channel, ts); }
      for (const [channel, ts] of newest) await request("conversations.mark", { channel, ts }, true);
    },
    async delete(_account: string, externalId: string) {
      const { channel, ts } = externalParts(externalId);
      // Slack enforces ownership and its deletion window with the user's token.
      await request("chat.delete", { channel, ts }, true);
    }
  };
}
export function createSlackSendAdapter(options: SlackOptions & SendOptions) {
  const request = createSlackTransport(options);
  return {
    toProviderText: markdownToSlack,
    async send(item: OutboxItem) {
      const channel = item.to.channel;
      if (!channel || !/^[A-Z0-9]+$/.test(channel)) throw new Error("A Slack channel is required");
      const text = markdownToSlack(item.body.markdown);
      const threadTs = item.replyToExternalId ? externalParts(item.replyToExternalId).ts : undefined;
      if (!item.attachments.length) {
        const sent = await request("chat.postMessage", { channel, text, thread_ts: threadTs, client_msg_id: item.id, unfurl_links: false, unfurl_media: false }, true);
        return { externalId: `${channel}:${sent.ts}` };
      }
      if (!options.readFile) throw new Error("Attachment storage is unavailable");
      const uploaded: { id: string; title: string }[] = [];
      for (const file of item.attachments) {
        const bytes = await options.readFile(file.path);
        const ticket = await request("files.getUploadURLExternal", { filename: file.name, length: bytes.byteLength }, true);
        const url = safeHttpsUrl(ticket.upload_url, ["slack.com"]);
        const sent = await (options.fetchImpl ?? fetch)(url, { method: "POST", body: bytes as BodyInit, headers: { "content-type": "application/octet-stream" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (!sent.ok) throw new ProviderHttpError(sent.status, "Slack upload failed");
        uploaded.push({ id: ticket.file_id, title: file.name });
      }
      const result = await request("files.completeUploadExternal", { files: uploaded, channel_id: channel, initial_comment: text, thread_ts: threadTs }, true);
      const file = result.files?.[0];
      const shareTs = file?.shares?.private?.[channel]?.[0]?.ts ?? file?.shares?.public?.[channel]?.[0]?.ts;
      if (shareTs) return { externalId: `${channel}:${shareTs}` };
      // Completion can omit the share timestamp. Query the uploaded file metadata before reporting it.
      const detail = await request("files.info", { file: uploaded[0].id });
      const verifiedTs = detail.file?.shares?.private?.[channel]?.[0]?.ts ?? detail.file?.shares?.public?.[channel]?.[0]?.ts;
      if (!verifiedTs) throw new Error("Slack uploaded the file but has not returned its message timestamp; check the conversation before retrying");
      return { externalId: `${channel}:${verifiedTs}` };
    }
  };
}
