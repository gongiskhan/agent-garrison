import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import { assertValidJid } from "./jid.mjs";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function idFor(account, external, timestamp = 0) {
  let time = Math.max(0, Math.floor(timestamp));
  let prefix = "";
  for (let i = 0; i < 10; i++) { prefix = alphabet[time % 32] + prefix; time = Math.floor(time / 32); }
  const hash = createHash("sha256").update(JSON.stringify(["whatsapp-web", account, external])).digest();
  return prefix + Array.from(hash.subarray(0, 16), byte => alphabet[byte % 32]).join("");
}
export function whatsappDescriptor(account = "default", connected = false) {
  return { id: "whatsapp-web", kind: "chat", label: "WhatsApp", badge: { text: "WhatsApp", color: "#15803d", glyph: "MessageCircle" },
    accounts: [{ id: account, label: account === "default" ? "WhatsApp" : account.split("@")[0], ...(account === "default" ? {} : { address: account }) }],
    capabilities: { read: true, send: true, reply: true, markRead: true, archive: false, delete: true, groups: true, threads: false,
      attachments: true, audioReceive: true, audioSend: true, markdown: true, code: true, reactionsRead: false, openInProvider: true },
    sync: { mode: "stream" }, sendReadReceipts: true, setupHint: connected ? null : "Pair WhatsApp in its fitting", holdSeconds: 60, managesAgentHold: true, deleteWindowSeconds: 172800 };
}
function unwrap(message) {
  return message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message?.viewOnceMessageV2?.message ?? message ?? {};
}
export function whatsappToProviderText(markdown) {
  const code = [];
  let value = String(markdown).replace(/```[\s\S]*?```|`[^`\n]*`/g, block => {
    code.push(block.replace(/^```[^\n`]*\n/, "```\n")); return `\u0000${code.length - 1}\u0000`;
  });
  value = value.replace(/\*\*([^*]+)\*\*/g, "*$1*").replace(/~~([^~]+)~~/g, "~$1~")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)");
  return value.replace(/\u0000(\d+)\u0000/g, (_m, index) => code[Number(index)]);
}
export function whatsappFromProviderText(raw) {
  const code = [];
  const source = String(raw ?? "");
  let value = source.replace(/```[\s\S]*?```|`[^`\n]*`/g, block => { code.push(block); return `\u0000${code.length - 1}\u0000`; });
  value = value.replace(/(^|\s)\*([^*\n]+)\*(?=$|[\s.,!?])/g, "$1**$2**").replace(/(^|\s)~([^~\n]+)~(?=$|[\s.,!?])/g, "$1~~$2~~");
  return { text: source, markdown: value.replace(/\u0000(\d+)\u0000/g, (_m, index) => code[Number(index)]) };
}
export function normalizeWhatsAppMessage(raw, { account = "default", contactName = () => null, group = null, now = () => Date.now() } = {}) {
  const jid = raw.key?.remoteJid;
  if (!jid || !raw.key?.id || jid === "status@broadcast") return null;
  const payload = unwrap(raw.message);
  const media = payload.imageMessage ?? payload.audioMessage ?? payload.documentMessage ?? payload.videoMessage;
  const body = payload.conversation ?? payload.extendedTextMessage?.text ?? media?.caption ?? "";
  if (!body && !media) return null;
  const timestamp = Number(raw.messageTimestamp) * 1000 || now();
  const ts = new Date(timestamp).toISOString();
  const externalId = `${jid}:${raw.key.id}`;
  const conversationId = idFor(account, `conversation:${jid}`);
  const senderId = raw.key.fromMe ? account : raw.key.participant ?? jid;
  const sender = { id: senderId, name: raw.key.fromMe ? "Me" : raw.pushName ?? contactName(senderId) ?? senderId.split("@")[0], isMe: !!raw.key.fromMe };
  const normalized = whatsappFromProviderText(body);
  const attachments = media ? [{ id: idFor(account, `attachment:${externalId}`), kind: payload.imageMessage ? "image" : payload.audioMessage ? "audio" : "file",
    name: media.fileName ?? (payload.imageMessage ? "Photo.jpg" : payload.audioMessage ? "Voice note.ogg" : "File"),
    mime: media.mimetype ?? (payload.imageMessage ? "image/jpeg" : payload.audioMessage ? "audio/ogg" : "application/octet-stream"),
    size: Number(media.fileLength ?? 0), path: null, thumbPath: null, playbackPath: null,
    durationMs: media.seconds ? Number(media.seconds) * 1000 : null, transcript: null,
    transcriptStatus: payload.audioMessage ? "pending" : "none", externalRef: externalId,
    ...(media.width ? { width: Number(media.width), height: Number(media.height) } : {}) }] : [];
  const message = { id: idFor(account, externalId, timestamp), provider: "whatsapp-web", account, conversationId, externalId,
    direction: raw.key.fromMe ? "out" : "in", sender, recipients: [], subject: null, bodyText: normalized.text, bodyMarkdown: normalized.markdown,
    bodyHtmlPath: null, attachments, ts, receivedTs: new Date(now()).toISOString(), read: !!raw.key.fromMe,
    archived: false, deleted: false, starred: false, labels: [], category: null, severity: null, action: null,
    cardId: null, conversationRef: null, triage: null, rawPath: null,
    ...(jid.endsWith("@s.whatsapp.net") ? { deepLink: `https://wa.me/${jid.split("@")[0]}` } : {}) };
  const conversation = { id: conversationId, provider: "whatsapp-web", account, externalId: jid,
    kind: jid.endsWith("@g.us") ? "group" : "dm", title: group?.subject ?? contactName(jid) ?? (jid.endsWith("@g.us") ? jid : raw.pushName) ?? jid.split("@")[0],
    participants: group?.participants?.map(p => ({ id: p.id, name: contactName(p.id) ?? p.id.split("@")[0], isMe: p.id === account })) ?? [sender],
    lastMessageTs: ts, unreadCount: message.read ? 0 : 1, muted: false, pinned: false, archived: false, parentConversationId: null };
  return { message, conversation };
}

/** Full message reconciliation is separate from the bounded legacy HUD history. */
export class WhatsAppMessagesStore {
  constructor(root, { now = () => Date.now() } = {}) {
    this.root = root;
    this.now = now;
    this.file = path.join(root, "provider-journal", "whatsapp-web.json");
    try { this.entries = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.entries = []; }
  }
  append(raw, normalized) {
    if (!normalized) return false;
    const existing = this.entries.find(entry => entry.message.externalId === normalized.message.externalId && entry.message.account === normalized.message.account);
    const comparable = record => JSON.stringify({ ...record, message: { ...record.message, receivedTs: "", rawPath: null } });
    if (existing && comparable(existing) === comparable(normalized)) return false;
    const rawPath = path.join(this.root, "raw", "whatsapp-web", encodeURIComponent(normalized.message.account), `${normalized.message.id}.json`);
    mkdirSync(path.dirname(rawPath), { recursive: true, mode: 0o700 });
    writeFileSync(rawPath, JSON.stringify(raw, (_key, value) => typeof value === "bigint" ? value.toString() : value), { mode: 0o600 });
    normalized.message.rawPath = rawPath;
    this.entries = this.entries.filter(entry => entry.message.id !== normalized.message.id && Date.parse(entry.message.ts) >= this.now() - 24 * 3600_000);
    this.entries.push(normalized);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.entries), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    return true;
  }
  fetch(account, cursor = null) {
    const since = Math.max(this.now() - 24 * 3600_000, cursor?.receivedTs ? Date.parse(cursor.receivedTs) - 1000 : 0);
    const entries = this.entries.filter(entry => entry.message.account === account && Date.parse(entry.message.receivedTs) >= since);
    const conversations = new Map();
    for (const entry of entries) {
      const previous = conversations.get(entry.conversation.id);
      if (!previous || previous.lastMessageTs < entry.conversation.lastMessageTs) conversations.set(entry.conversation.id, entry.conversation);
    }
    return { messages: entries.map(entry => this.expose(entry).message), conversations: [...conversations.values()], cursor: { receivedTs: new Date(this.now()).toISOString() } };
  }
  expose(entry) {
    const rawPath = entry.message.rawPath ? path.relative(this.root, entry.message.rawPath).split(path.sep).join("/") : null;
    if (rawPath && (rawPath.startsWith("../") || path.isAbsolute(rawPath))) throw new Error("Raw message path is outside Messages storage");
    return { ...entry, message: { ...entry.message, rawPath } };
  }
  get(externalId) { return this.entries.find(entry => entry.message.externalId === externalId); }
  raw(externalId) {
    const entry = this.get(externalId);
    if (!entry?.message.rawPath || !existsSync(entry.message.rawPath)) throw new Error("WhatsApp message is no longer available on its owner");
    return JSON.parse(readFileSync(entry.message.rawPath, "utf8"), (_key, value) => value?.type === "Buffer" && Array.isArray(value.data) ? Buffer.from(value.data) : value);
  }
}

export function createWhatsAppMessagesAdapter({ connectionManager, messagesStore, outbox, root, now = () => Date.now() }) {
  const destination = candidate => {
    const resolved = path.resolve(candidate);
    const allowed = path.resolve(root, "attachments");
    if (!resolved.startsWith(`${allowed}${path.sep}`)) throw new Error("Attachment path is outside Messages storage");
    let existing = resolved;
    while (!existsSync(existing)) existing = path.dirname(existing);
    const realRoot = existsSync(root) ? realpathSync(root) : path.resolve(root);
    const realExisting = realpathSync(existing);
    if (lstatSync(existing).isSymbolicLink() || (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${path.sep}`))) throw new Error("Attachment path follows a symlink outside Messages storage");
    return resolved;
  };
  return {
    fetchMessages: ({ account, cursor }) => messagesStore.fetch(account, cursor),
    listConversations: ({ account }) => messagesStore.fetch(account).conversations,
    health: () => ({ ok: connectionManager.status().connected, reason: connectionManager.status().connected ? undefined : "Pair WhatsApp in its fitting" }),
    async downloadAttachment({ account, ref, dest }) {
      const entry = messagesStore.get(ref);
      if (!entry || entry.message.account !== account) throw new Error("Unknown WhatsApp attachment");
      const bytes = await connectionManager.downloadMedia(messagesStore.raw(ref));
      if (!dest) return { mime: entry.message.attachments[0]?.mime ?? "application/octet-stream", size: bytes.length, contentBase64: Buffer.from(bytes).toString("base64") };
      const output = destination(dest);
      mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, bytes, { mode: 0o600 });
      return { mime: entry.message.attachments[0]?.mime ?? "application/octet-stream", size: bytes.length, path: output };
    },
    async setRead({ account, messageExternalIds = [], ids = messageExternalIds, read = true, sendReadReceipts = true }) {
      if (!read || !sendReadReceipts) return { ok: true };
      const records = ids.map(id => messagesStore.get(id)).filter(record => record?.message.account === account);
      await connectionManager.readMessages(records.map(record => messagesStore.raw(record.message.externalId).key));
      return { ok: true };
    },
    async delete({ account, messageExternalId, externalId = messageExternalId }) {
      const record = messagesStore.get(externalId);
      if (!record || record.message.account !== account || record.message.direction !== "out") throw new Error("Only your own WhatsApp messages can be deleted");
      if (now() - Date.parse(record.message.ts) > 48 * 3600_000) throw new Error("WhatsApp delete window has expired");
      await connectionManager.deleteMessage(messagesStore.raw(externalId).key);
      return { ok: true };
    },
    async send({ item }) {
      const jid = item?.to?.jid;
      assertValidJid(jid);
      const body = whatsappToProviderText(item.body?.markdown ?? "");
      const attachments = (item.attachments ?? []).map(file => ({ ...file, path: destination(file.path) }));
      if (!body.trim() && !attachments.length) throw new Error("A message or attachment is required");
      if (!connectionManager.status().connected) throw new Error("Pair WhatsApp in its fitting");
      if (item.origin !== "user") {
        const existing = outbox.read().find(entry => entry.payload?.messagesOutboxId === item.id);
        const entry = existing ?? outbox.enqueue({ action: "send_message", payload: { jid, body, attachments, messagesOutboxId: item.id }, summary: "WhatsApp message", context: "agent" });
        return { queued: true, id: entry.id, status: entry.status, executeAt: entry.executeAt, holdUntil: entry.executeAt };
      }
      const sent = await connectionManager.sendMedia(jid, body, attachments);
      return { externalId: `${jid}:${sent.id}`, conversationExternalId: jid };
    },
    outboxStatus({ id }) {
      const entry = outbox.get(id);
      if (!entry) throw new Error("Unknown WhatsApp outbox item");
      return { id: entry.id, status: entry.status, error: entry.error,
        ...(entry.result?.id ? { externalId: `${entry.payload.jid}:${entry.result.id}`, conversationExternalId: entry.payload.jid } : {}) };
    },
    cancelSend: ({ id }) => outbox.cancel(id)
  };
}
