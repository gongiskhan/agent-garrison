import { marked, type Token } from "marked";
import type { Conversation, Message, OutboxItem, ProviderDescriptor } from "../types";
import { attachmentId, baseAttachment, baseConversation, baseMessage, participant, ProviderHttpError,
  providerId, safeHttpsUrl, type Account, type JsonRecord, type SendOptions, type TransportOptions } from "./shared";

export const SLACK_MESSAGES_SCOPES = ["channels:history", "groups:history", "im:history", "mpim:history",
  "channels:read", "groups:read", "im:read", "mpim:read", "users:read", "chat:write", "files:write", "files:read", "reactions:read",
  "channels:write", "groups:write", "im:write", "mpim:write"];
export function slackDescriptor(accounts: Account[], setupHint: string | null = null): ProviderDescriptor {
  return { id: "slack", kind: "chat", label: "Slack", badge: { text: "Slack", color: "#611f69", glyph: "Hash" }, accounts,
    capabilities: { read: true, send: true, reply: true, markRead: true, archive: false, delete: true,
      groups: true, threads: true, attachments: true, audioReceive: true, audioSend: true,
      markdown: true, code: true, reactionsRead: true, openInProvider: true }, sync: { mode: "poll", intervalSeconds: 60 }, setupHint };
}
export interface SlackOptions extends TransportOptions { sleep?: (ms: number) => Promise<void>; ownUserId?: string; workspaceId?: string; }
export interface SlackCursor extends Record<string, unknown> { channels?: Record<string, string>; threads?: Record<string, string>; }

function escapeSlack(text: string) { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function slackTokens(tokens: Token[]): string {
  return tokens.map((token: Token): string => {
    const t = token as JsonRecord;
    const inner = () => t.tokens ? slackTokens(t.tokens) : escapeSlack(t.text ?? "");
    switch (t.type) {
      case "space": return "\n";
      case "strong": return `*${inner()}*`;
      case "em": return `_${inner()}_`;
      case "del": return `~${inner()}~`;
      case "codespan": return `\`${t.text}\``;
      case "code": return `\`\`\`\n${t.text}\n\`\`\`\n`;
      case "link": return `<${String(t.href).replace(/[<>|]/g, "")}|${inner()}>`;
      case "image": return `<${String(t.href).replace(/[<>|]/g, "")}|${escapeSlack(t.text || "Image")}>`;
      case "heading": return `*${inner()}*\n`;
      case "paragraph": return `${inner()}\n`;
      case "br": return "\n";
      case "blockquote": return inner().split("\n").map((line: string) => `> ${line}`).join("\n");
      case "list": return t.items.map((item: JsonRecord, index: number) => `${t.ordered ? `${Number(t.start || 1) + index}.` : "•"} ${slackTokens(item.tokens).trim()}\n`).join("");
      case "html": return escapeSlack(t.raw);
      default: return inner();
    }
  }).join("");
}
export function markdownToSlack(markdown: string): string { return slackTokens(marked.lexer(markdown, { gfm: true })).trimEnd(); }
export function slackFromProviderText(raw: unknown, names: Record<string, string> = {}): { text: string; markdown: string } {
  const text = typeof raw === "string" ? raw : String((raw as JsonRecord)?.text ?? "");
  const protectedCode: string[] = [];
  let value = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, block => { protectedCode.push(block); return `\u0000${protectedCode.length - 1}\u0000`; });
  value = value.replace(/<@([A-Z0-9]+)>/g, (_m, id) => `@${names[id] ?? id}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id, label) => `#${label ?? names[id] ?? id}`)
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^>|]+|mailto:[^>|]+)(?:\|([^>]+))?>/g, (_m, url, label) => `[${label ?? url}](${url})`)
    .replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s.,!?:;)\]}])/g, "$1**$2**")
    .replace(/(^|[\s([{])~([^~\n]+)~(?=$|[\s.,!?:;)\]}])/g, "$1~~$2~~")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const markdown = value.replace(/\u0000(\d+)\u0000/g, (_match, index) => protectedCode[Number(index)]);
  const plain = markdown.replace(/```(?:[^\n]*\n)?([\s\S]*?)```/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/_([^_]+)_/g, "$1");
  return { text: plain, markdown };
}

export function externalParts(id: string) {
  const match = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(id);
  if (!match) throw new Error("Invalid Slack message reference");
  return { channel: match[1], ts: match[2] };
}
export function normalizeSlackMessage(raw: JsonRecord, channel: JsonRecord, account: string, names: Record<string, string> = {}, ownUserId = "", receivedTs = new Date().toISOString()) {
  const ts = new Date(Number(raw.ts) * 1000).toISOString();
  const parent = baseConversation("slack", account, channel.id, channel.is_im ? "dm" : channel.is_mpim ? "group" : "channel", channel.name || names[channel.user] || channel.user || channel.id, ts);
  parent.archived = !!channel.is_archived;
  const rootTs = raw.thread_ts && raw.thread_ts !== raw.ts ? String(raw.thread_ts) : null;
  const conversation = rootTs ? baseConversation("slack", account, `${channel.id}:${rootTs}`, "thread", parent.title, ts) : parent;
  if (rootTs) conversation.parentConversationId = parent.id;
  const message = baseMessage("slack", account, `${channel.id}:${raw.ts}`, conversation.id, ts, receivedTs);
  const senderId = String(raw.user ?? raw.bot_id ?? "unknown");
  message.sender = participant(senderId, names[senderId] ?? raw.username ?? senderId, senderId === ownUserId);
  message.direction = message.sender.isMe ? "out" : "in";
  const body = slackFromProviderText(raw.text ?? "", names);
  message.bodyText = body.text;
  message.bodyMarkdown = body.markdown;
  message.read = message.direction === "out" || Number(raw.ts) <= Number(channel.last_read ?? 0);
  message.archived = !!channel.is_archived;
  message.reactions = (raw.reactions ?? []).map((reaction: JsonRecord) => ({ name: String(reaction.name), count: Number(reaction.count), users: reaction.users ?? [] }));
  message.attachments = (raw.files ?? []).map((file: JsonRecord) => ({
    ...baseAttachment(attachmentId("slack", account, file.id), String(file.name ?? file.title ?? "File"), String(file.mimetype ?? "application/octet-stream"), Number(file.size ?? 0)),
    externalRef: String(file.id), ...(file.original_w ? { width: Number(file.original_w), height: Number(file.original_h) } : {}),
    ...(file.duration_ms ? { durationMs: Number(file.duration_ms) } : {})
  }));
  conversation.participants = [message.sender];
  conversation.unreadCount = message.read ? 0 : 1;
  message.deepLink = `https://app.slack.com/client/${encodeURIComponent(account)}/${encodeURIComponent(channel.id)}/thread/${encodeURIComponent(channel.id)}-${encodeURIComponent(rootTs ?? raw.ts)}`;
  return { message, conversation, parent };
}
