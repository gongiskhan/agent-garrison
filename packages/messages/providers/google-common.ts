import type { Conversation, Message, OutboxItem, ProviderDescriptor } from "../types";
import { attachmentId, baseAttachment, baseConversation, baseMessage, decodeBase64, encodeBase64,
  headerText, participant, ProviderHttpError, providerId, type Account, type JsonRecord,
  type SendOptions, type TransportOptions } from "./shared";
export const GOOGLE_MESSAGES_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/drive.readonly"];
export function googleDescriptor(accounts: Account[], setupHint: string | null = null): ProviderDescriptor {
  return { id: "google", kind: "mail", label: "Gmail", badge: { text: "Gmail", color: "#b45309", glyph: "Mail" }, accounts,
    capabilities: { read: true, send: true, reply: true, markRead: true, archive: true, delete: true,
      groups: false, threads: true, attachments: true, audioReceive: true, audioSend: true,
      markdown: true, code: true, reactionsRead: false, openInProvider: true },
    sync: { mode: "poll", intervalSeconds: 120 }, setupHint,
    inboundStateFields: ["read", "archived", "deleted", "starred", "labels"] };
}

export interface GoogleCursor extends Record<string, unknown> { historyId?: string; }
export interface GoogleSyncResult { messages: Message[]; conversations: Conversation[]; cursor: GoogleCursor; deletedExternalIds: string[]; }
export interface GoogleReadOptions extends TransportOptions {
  accountAddress?: string;
  storeHtml?: (messageId: string, html: string, remoteImages?: string[]) => Promise<string>;
  storeRaw?: (messageId: string, payload: JsonRecord) => Promise<string>;
}

export function parseMailParticipants(raw: string, ownAddress = "") {
  const result = [];
  const pieces = raw.match(/(?:"[^"]*"|[^,])+/g) ?? [];
  for (const piece of pieces) {
    const match = /^(.*?)<([^>]+)>$/.exec(piece.trim());
    const address = (match?.[2] ?? piece).trim();
    if (!address) continue;
    const name = (match?.[1]?.trim().replace(/^"|"$/g, "") || address);
    result.push(participant(address.toLowerCase(), name, address.toLowerCase() === ownAddress.toLowerCase(), address));
  }
  return result;
}
export function flattenParts(payload: JsonRecord): JsonRecord[] { return [payload, ...(payload.parts ?? []).flatMap(flattenParts)]; }
function decodeText(data: unknown): string { return typeof data === "string" ? Buffer.from(data, "base64url").toString("utf8") : ""; }
export function googleFromProviderText(raw: unknown): { text: string; markdown: string | null } {
  return { text: typeof raw === "string" ? raw : "", markdown: null };
}
export function normalizeGoogleMessage(raw: JsonRecord, account: string, ownAddress = "", receivedTs = new Date().toISOString()) {
  const headers = new Map<string, string>((raw.payload?.headers ?? []).map((h: JsonRecord) => [String(h.name).toLowerCase(), String(h.value)]));
  const parts = flattenParts(raw.payload ?? {});
  const plain = parts.filter(p => p.mimeType === "text/plain" && !p.filename).map(p => decodeText(p.body?.data)).join("\n");
  const html = parts.filter(p => p.mimeType === "text/html" && !p.filename).map(p => decodeText(p.body?.data)).join("\n");
  const ts = new Date(Number(raw.internalDate) || Date.parse(headers.get("date") ?? "") || Date.parse(receivedTs)).toISOString();
  const externalId = String(raw.id);
  const threadId = String(raw.threadId ?? externalId);
  const conversation = baseConversation("google", account, threadId, "mail-thread", headers.get("subject") ?? "(No subject)", ts);
  const message = baseMessage("google", account, externalId, conversation.id, ts, receivedTs);
  message.sender = parseMailParticipants(headers.get("from") ?? "", ownAddress)[0] ?? participant("unknown");
  const to = parseMailParticipants(headers.get("to") ?? "", ownAddress);
  const cc = parseMailParticipants(headers.get("cc") ?? "", ownAddress);
  message.recipients = [...to, ...cc];
  message.subject = headers.get("subject") ?? null;
  message.labels = Array.from(new Set<string>(raw.labelIds ?? []));
  message.read = !message.labels.includes("UNREAD");
  message.archived = !message.labels.includes("INBOX");
  message.deleted = message.labels.includes("TRASH");
  message.starred = message.labels.includes("STARRED");
  message.direction = message.labels.includes("SENT") || message.sender.isMe ? "out" : "in";
  message.bodyText = plain || String(raw.snippet ?? "");
  message.attachments = parts.filter(p => p.filename || (p.body?.attachmentId && !String(p.mimeType).startsWith("text/"))).map(p => ({
    ...baseAttachment(attachmentId("google", account, `${externalId}:${p.partId ?? p.body.attachmentId}`), String(p.filename || "attachment"), String(p.mimeType || "application/octet-stream"), Number(p.body?.size ?? 0)),
    externalRef: `${externalId}/${p.body?.attachmentId ?? `part:${p.partId ?? "0"}`}`
  }));
  conversation.participants = Array.from(new Map([message.sender, ...message.recipients].map(p => [p.id, p])).values());
  conversation.unreadCount = message.read ? 0 : 1;
  conversation.archived = message.archived;
  return { message, conversation, html, mail: { to, cc, messageId: headers.get("message-id") ?? null, references: headers.get("references") ?? null } };
}
