import { createHash } from "node:crypto";
import type { Attachment, Conversation, Message, Participant, ProviderDescriptor } from "../types";

export type JsonRecord = Record<string, any>;
export interface TransportOptions {
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  writeFile?: (destination: string, bytes: Uint8Array) => Promise<void>;
}
export interface SendOptions extends TransportOptions {
  readFile?: (path: string) => Promise<Uint8Array>;
}
export type Account = ProviderDescriptor["accounts"][number];

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function providerId(provider: string, account: string, external: string, ts = 0): string {
  let time = Math.max(0, Math.floor(ts));
  let prefix = "";
  for (let i = 0; i < 10; i++) { prefix = alphabet[time % 32] + prefix; time = Math.floor(time / 32); }
  const hash = createHash("sha256").update(JSON.stringify([provider, account, external])).digest();
  return prefix + Array.from(hash.subarray(0, 16), byte => alphabet[byte % 32]).join("");
}
export function attachmentId(provider: string, account: string, external: string): string {
  return providerId(provider, account, `attachment:${external}`);
}
export function participant(id: string, name = id, isMe = false, address?: string): Participant {
  return { id, name, isMe, ...(address ? { address } : {}) };
}
export function baseMessage(provider: string, account: string, externalId: string, conversationId: string, ts: string, receivedTs: string): Message {
  return {
    id: providerId(provider, account, externalId, Date.parse(ts)), provider, account, externalId,
    conversationId, direction: "in", sender: participant("unknown"), recipients: [], subject: null,
    bodyText: "", bodyMarkdown: null, bodyHtmlPath: null, attachments: [], ts, receivedTs,
    read: false, archived: false, deleted: false, starred: false, labels: [], category: null,
    severity: null, action: null, cardId: null, conversationRef: null, triage: null, rawPath: null
  };
}
export function baseConversation(provider: string, account: string, externalId: string, kind: Conversation["kind"], title: string, ts: string): Conversation {
  return { id: providerId(provider, account, `conversation:${externalId}`), provider, account, externalId,
    kind, title, participants: [], lastMessageTs: ts, unreadCount: 0, muted: false, pinned: false,
    archived: false, parentConversationId: null };
}
export function baseAttachment(id: string, name: string, mime: string, size: number): Attachment {
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "file";
  return { id, kind, name, mime, size, path: null, thumbPath: null, playbackPath: null,
    durationMs: null, transcript: null, transcriptStatus: kind === "audio" ? "pending" : "none" };
}
export function headerText(input: unknown): string { return String(input ?? "").replace(/[\r\n]+/g, " ").trim(); }
export function decodeBase64(input: string): Uint8Array { return Buffer.from(input, "base64url"); }
export function encodeBase64(input: string | Uint8Array): string { return Buffer.from(input).toString("base64url"); }
export function safeHttpsUrl(raw: string, hosts?: string[]): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (hosts && !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)))) {
    throw new Error("Provider returned an unsupported attachment URL");
  }
  return url;
}
export class ProviderHttpError extends Error {
  constructor(public status: number, public code: string, public retryAfterMs = 0) { super(`${code} (${status})`); }
}
