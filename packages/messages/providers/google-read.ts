import type { Conversation, Message, OutboxItem, ProviderDescriptor } from "../types";
import { attachmentId, baseAttachment, baseConversation, baseMessage, decodeBase64, encodeBase64,
  headerText, participant, ProviderHttpError, providerId, type Account, type JsonRecord,
  type SendOptions, type TransportOptions } from "./shared";
import { sanitizeMailHtml } from "./mail-html";
import { normalizeGoogleMessage, googleFromProviderText, flattenParts, type GoogleReadOptions, type GoogleCursor, type GoogleSyncResult } from "./google-common";
function gmailReadTransport({ token, fetchImpl = fetch }: TransportOptions) {
  if (!token) throw new Error("Google needs setup: reconnect with mail read scope");
  return async (path: string, options: RequestInit = {}): Promise<JsonRecord> => {
    if (options.method && options.method !== "GET") throw new Error("Google ingest is read only");
    if (!/^(?:profile|labels$|messages(?:[/?]|$)|threads(?:[/?]|$)|history\?)/.test(path)) throw new Error("Unsupported Google read endpoint");
    const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",  },
      signal: options.signal ?? AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new ProviderHttpError(response.status, "Google request failed", Number(response.headers.get("retry-after") ?? 0) * 1000);
    return response.status === 204 ? {} : response.json();
  };
}
export function createGoogleReadAdapter(options: GoogleReadOptions) {
  const request = gmailReadTransport(options);
  const now = options.now ?? (() => new Date());
  const normalize = async (raw: JsonRecord, account: string) => {
    const normalized = normalizeGoogleMessage(raw, account, options.accountAddress, now().toISOString());
    if (normalized.html && options.storeHtml) {
      const safe = sanitizeMailHtml(normalized.html);
      normalized.message.bodyHtmlPath = await options.storeHtml(normalized.message.id, safe.html, safe.remoteImages);
    }
    if (options.storeRaw) normalized.message.rawPath = await options.storeRaw(normalized.message.id, raw);
    return normalized;
  };
  async function backfill(account: string): Promise<GoogleSyncResult> {
    // Capture the history boundary before listing, so changes during backfill are replayed next time.
    const profile = await request("profile");
    const ids: string[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q: "newer_than:30d", maxResults: String(Math.min(500, 2000 - ids.length)) });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await request(`messages?${params}`);
      ids.push(...(page.messages ?? []).map((m: JsonRecord) => String(m.id)));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken && ids.length < 2000);
    return load(ids.slice(0, 2000), [], account, { historyId: String(profile.historyId) });
  }
  async function load(ids: string[], deleted: string[], account: string, cursor: GoogleCursor): Promise<GoogleSyncResult> {
    const messages: Message[] = [];
    const conversations = new Map<string, Conversation>();
    for (const id of new Set(ids)) {
      try {
        const { message, conversation } = await normalize(await request(`messages/${encodeURIComponent(id)}?format=full`), account);
        messages.push(message);
        const existing = conversations.get(conversation.id);
        if (existing) {
          existing.unreadCount += conversation.unreadCount;
          if (conversation.lastMessageTs > existing.lastMessageTs) existing.lastMessageTs = conversation.lastMessageTs;
          existing.archived = existing.archived && conversation.archived;
          existing.participants = Array.from(new Map([...existing.participants, ...conversation.participants].map(p => [p.id, p])).values());
        } else conversations.set(conversation.id, conversation);
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) deleted.push(id);
        else throw error;
      }
    }
    return { messages, conversations: [...conversations.values()], cursor, deletedExternalIds: [...new Set(deleted)] };
  }
  return {
    getReplyHeaders(_account: string, externalId: string) { return fetchGoogleReplyHeaders(options, externalId); },
    async listLabels(): Promise<{ id: string; name: string; type: "system" | "user" }[]> {
      const result = await request("labels");
      return (Array.isArray(result.labels) ? result.labels : []).filter((label: JsonRecord) => typeof label.id === "string" && typeof label.name === "string")
        .map((label: JsonRecord) => ({ id: label.id, name: label.name, type: label.type === "user" ? "user" as const : "system" as const }))
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    },
    async fetchMessages(account: string, cursor: GoogleCursor | null): Promise<GoogleSyncResult> {
      if (!cursor?.historyId) return backfill(account);
      const ids: string[] = [], deleted: string[] = [];
      let pageToken = "", historyId = cursor.historyId;
      try {
        do {
          const params = new URLSearchParams({ startHistoryId: cursor.historyId, maxResults: "500" });
          if (pageToken) params.set("pageToken", pageToken);
          const page = await request(`history?${params}`);
          for (const history of page.history ?? []) {
            for (const field of ["messagesAdded", "labelsAdded", "labelsRemoved"]) {
              for (const change of history[field] ?? []) if (change.message?.id) ids.push(String(change.message.id));
            }
            for (const change of history.messagesDeleted ?? []) if (change.message?.id) deleted.push(String(change.message.id));
          }
          historyId = String(page.historyId ?? historyId);
          pageToken = page.nextPageToken ?? "";
        } while (pageToken);
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) return backfill(account);
        throw error;
      }
      return load(ids, deleted, account, { historyId });
    },
    async listConversations(account: string, since: string | null): Promise<Conversation[]> {
      const params = new URLSearchParams({ maxResults: "100" });
      if (since) params.set("q", `after:${Math.floor(Date.parse(since) / 1000)}`);
      const conversations: Conversation[] = [];
      let next = "";
      do {
        if (next) params.set("pageToken", next);
        const page = await request(`threads?${params}`);
        for (const thread of page.threads ?? []) {
          const detail = await request(`threads/${encodeURIComponent(thread.id)}?format=metadata`);
          const normalized = (detail.messages ?? []).map((m: JsonRecord) => normalizeGoogleMessage(m, account, options.accountAddress, now().toISOString()));
          const latest = normalized.sort((a: ReturnType<typeof normalizeGoogleMessage>, b: ReturnType<typeof normalizeGoogleMessage>) => a.message.ts.localeCompare(b.message.ts)).at(-1);
          if (latest) conversations.push({ ...latest.conversation, unreadCount: normalized.filter((n: ReturnType<typeof normalizeGoogleMessage>) => !n.message.read).length });
        }
        next = page.nextPageToken ?? "";
      } while (next);
      return conversations;
    },
    async downloadAttachment(_account: string, ref: string, destination: string) {
      const [messageId, attachmentId] = ref.split("/");
      if (!messageId || !attachmentId) throw new Error("Invalid Gmail attachment reference");
      if (!options.writeFile) throw new Error("Attachment storage is unavailable");
      let data: string;
      let mime = "application/octet-stream";
      if (attachmentId.startsWith("part:")) {
        const raw = await request(`messages/${encodeURIComponent(messageId)}?format=full`);
        const part = flattenParts(raw.payload ?? {}).find(part => String(part.partId ?? "0") === attachmentId.slice(5));
        if (!part?.body?.data) throw new Error("Gmail attachment content is unavailable");
        data = part.body.data;
        mime = part.mimeType ?? mime;
      } else {
        const payload = await request(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
        data = payload.data ?? "";
      }
      const bytes = decodeBase64(data);
      await options.writeFile(destination, bytes);
      return { mime, size: bytes.byteLength };
    },
    async health(_account: string) {
      try { await request("messages?maxResults=1"); return { ok: true }; }
      catch (error) { return { ok: false, reason: error instanceof ProviderHttpError && error.status === 403 ? "reconnect Google with mail read scope in Connectors" : String((error as Error).message) }; }
    },
    fromProviderText: googleFromProviderText,
    deepLink(conversation: Conversation) { return `https://mail.google.com/mail/u/${encodeURIComponent(options.accountAddress ?? conversation.account)}/#all/${encodeURIComponent(conversation.externalId ?? "")}`; }
  };
}

export async function fetchGoogleMailHtml(options: GoogleReadOptions, messageExternalId: string, loadImages = false) {
  const raw = await gmailReadTransport(options)(`messages/${encodeURIComponent(messageExternalId)}?format=full`);
  return sanitizeMailHtml(normalizeGoogleMessage(raw, "read", options.accountAddress).html, loadImages);
}

export async function fetchGoogleReplyHeaders(options: TransportOptions, externalId: string): Promise<{ messageId: string; references: string; subject: string; threadId: string }> {
  if (!externalId) throw new Error("A reply message reference is required");
  const query = new URLSearchParams({ format: "metadata", fields: "id,threadId,payload/headers" });
  for (const name of ["Message-ID", "References", "Subject"]) query.append("metadataHeaders", name);
  const raw = await gmailReadTransport(options)(`messages/${encodeURIComponent(externalId)}?${query}`);
  const headers = new Map<string, string>((raw.payload?.headers ?? []).map((header: JsonRecord) => [String(header.name).toLowerCase(), headerText(String(header.value))]));
  const messageId = headers.get("message-id") ?? "";
  if (!messageId || !raw.threadId) throw new Error("Gmail reply headers are unavailable");
  return { messageId, references: headers.get("references") ?? "", subject: headers.get("subject") ?? "", threadId: String(raw.threadId) };
}
