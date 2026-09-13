import type { Conversation, Message, OutboxItem, ProviderDescriptor } from "../types";
import { attachmentId, baseAttachment, baseConversation, baseMessage, decodeBase64, encodeBase64,
  headerText, participant, ProviderHttpError, providerId, type Account, type JsonRecord,
  type SendOptions, type TransportOptions } from "./shared";
import { marked } from "marked";
import { sanitizeMailHtml } from "./mail-html";
function gmailTransport({ token, fetchImpl = fetch }: TransportOptions) {
  if (!token) throw new Error("Google needs setup: reconnect with mail read scope");
  return async (path: string, options: RequestInit = {}): Promise<JsonRecord> => {
    const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new ProviderHttpError(response.status, "Google request failed", Number(response.headers.get("retry-after") ?? 0) * 1000);
    return response.status === 204 ? {} : response.json();
  };
}
export function createGoogleActionAdapter(options: TransportOptions) {
  const request = gmailTransport(options);
  const modify = async (ids: string[], addLabelIds: string[], removeLabelIds: string[]) => {
    for (let start = 0; start < ids.length; start += 1000) await request("messages/batchModify", {
      method: "POST", body: JSON.stringify({ ids: ids.slice(start, start + 1000), addLabelIds, removeLabelIds })
    });
  };
  return {
    setRead(_account: string, ids: string[], read: boolean) { return modify(ids, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []); },
    async archive(_account: string, conversationExternalId: string) { await request(`threads/${encodeURIComponent(conversationExternalId)}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["INBOX"] }) }); },
    async delete(_account: string, externalId: string) { await request(`messages/${encodeURIComponent(externalId)}/trash`, { method: "POST" }); },
    setStarred(_account: string, ids: string[], starred: boolean) { return modify(ids, starred ? ["STARRED"] : [], starred ? [] : ["STARRED"]); },
    async setLabels(_account: string, ids: string[], add: string[], remove: string[] = []) {
      if (remove.includes("TRASH")) for (const id of ids) await request(`messages/${encodeURIComponent(id)}/untrash`, { method: "POST" });
      if (add.includes("TRASH")) for (const id of ids) await request(`messages/${encodeURIComponent(id)}/trash`, { method: "POST" });
      const addLabels = add.filter(label => label !== "TRASH"), removeLabels = remove.filter(label => label !== "TRASH");
      if (addLabels.length || removeLabels.length) await modify(ids, addLabels, removeLabels);
    }
  };
}

export interface MailSendItem extends OutboxItem {
  mail?: { to?: string[]; cc?: string[]; subject?: string; messageId?: string; references?: string; threadId?: string };
}
export function markdownToMail(markdown: string) {
  return { text: markdown, html: sanitizeMailHtml(marked.parse(markdown, { async: false, gfm: true }) as string).html };
}
export async function buildGoogleMime(item: MailSendItem, readFile?: SendOptions["readFile"]): Promise<string> {
  const mail = item.mail ?? {};
  const to = mail.to?.join(", ") || item.to.address || "";
  const cc = mail.cc?.join(", ") || item.to.cc || "";
  if (!to || !/[^\s@]+@[^\s@]+/.test(to)) throw new Error("A mail recipient is required");
  const boundary = `garrison_${providerId("google", item.account, item.id)}`;
  const alternative = `${boundary}_alternative`;
  const content = markdownToMail(item.body.markdown);
  const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64").replace(/(.{76})/g, "$1\r\n");
  const rows = [`To: ${headerText(to)}`, ...(cc ? [`Cc: ${headerText(cc)}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(headerText(mail.subject ?? item.to.subject ?? "")).toString("base64")}?=`, "MIME-Version: 1.0",
    ...(mail.messageId ? [`In-Reply-To: ${headerText(mail.messageId)}`, `References: ${headerText([mail.references, mail.messageId].filter(Boolean).join(" "))}`] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`, "", `--${alternative}`,
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(content.text),
    `--${alternative}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(content.html), `--${alternative}--`];
  for (const attachment of item.attachments) {
    if (!readFile) throw new Error("Attachment storage is unavailable");
    const bytes = await readFile(attachment.path);
    const name = headerText(attachment.name).replace(/["\\]/g, "_");
    rows.push(`--${boundary}`, `Content-Type: ${headerText(attachment.mime)}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", b64(bytes));
  }
  rows.push(`--${boundary}--`, "");
  return rows.join("\r\n");
}
export function createGoogleSendAdapter(options: SendOptions) {
  const request = gmailTransport(options);
  return {
    toProviderText: (markdown: string) => markdownToMail(markdown).html,
    async send(item: MailSendItem) {
      const raw = await buildGoogleMime(item, options.readFile);
      const sent = await request("messages/send", { method: "POST", body: JSON.stringify({ raw: encodeBase64(raw), ...(item.mail?.threadId ? { threadId: item.mail.threadId } : {}) }) });
      return { externalId: String(sent.id), conversationExternalId: String(sent.threadId ?? item.mail?.threadId ?? sent.id) };
    }
  };
}
