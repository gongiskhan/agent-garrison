// Local message store — a small append-only JSONL file next to the Baileys
// session data (see CLAUDE.md-style rule: keep it outside apm_modules so a
// reinstall never wipes it, and outside the Vault since it's not a secret).
// `last_message`/`recent_messages` read the in-memory index this file backs,
// so neither call re-syncs Baileys history — and per the brief, history is
// only ever reliable from the moment of pairing onward: Baileys does not
// backfill anything that happened before it first connected, so this store
// only ever contains messages seen since then.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_RECENT = 500;

export class MessageStore {
  constructor(sessionDir, { maxRecent = DEFAULT_MAX_RECENT } = {}) {
    this.dir = sessionDir;
    this.file = path.join(sessionDir, "messages.jsonl");
    this.maxRecent = maxRecent;
    this.recent = [];
    this.lastByChat = new Map();
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    let raw = "";
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this._index(JSON.parse(trimmed));
      } catch {
        // Skip a corrupt/partial trailing line (e.g. a crash mid-write)
        // rather than failing the whole store load.
      }
    }
  }

  _index(message) {
    this.recent.push(message);
    if (this.recent.length > this.maxRecent) this.recent.shift();
    const existing = this.lastByChat.get(message.chatJid);
    if (!existing || message.timestamp >= existing.timestamp) {
      this.lastByChat.set(message.chatJid, message);
    }
  }

  // Persist one message record and update the in-memory index. Fields:
  // { id, chatJid, chatName, fromMe, sender, senderName, body, timestamp, type }
  append(message) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    this._index(message);
  }

  recentMessages(n = 20) {
    const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
    return this.recent.slice(-count).reverse();
  }

  lastForChat(chatJid) {
    return this.lastByChat.get(chatJid) ?? null;
  }
}
