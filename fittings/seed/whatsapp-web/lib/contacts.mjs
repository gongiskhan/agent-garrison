// Chat/contact name -> jid index.
//
// Sources, in order of how much they actually supply:
//   - messaging-history.set : the phone replays its address book and chat
//     list here right after pairing (and on a resync). This is where the BULK
//     comes from. Listening only to the upsert events - as this Fitting did
//     originally - left the index EMPTY on a freshly paired account, so
//     resolve_contact could never answer and send_text was unusable by name.
//   - contacts.upsert / contacts.update / chats.upsert : incremental updates.
//   - pushName on inbound messages : whoever writes to you becomes
//     resolvable even if they were never in the synced address book.
//
// The index is CACHED TO DISK next to the session (contacts.json, 0600).
// It used to be memory-only, which meant every daemon restart threw the whole
// address book away and left the Operative unable to name anyone until a new
// sync happened to arrive.
//
// resolve() is the ONLY lookup surface - it always returns a LIST of
// candidates, ranked best-match first, and NEVER collapses to a single guess.
// That contract is what makes send_text's "must be an already-confirmed jid"
// rule enforceable: nothing upstream of the human ever gets to pick for them.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

export class ContactIndex {
  constructor(filePath = null) {
    this.byJid = new Map();
    this.filePath = filePath;
    this._saveTimer = null;
  }

  upsert(jid, name) {
    if (!jid || !name) return;
    const next = String(name).trim();
    if (!next) return;
    const prev = this.byJid.get(jid);
    if (prev && prev.name === next) return;
    this.byJid.set(jid, { jid, name: next });
    this._scheduleSave();
  }

  get size() {
    return this.byJid.size;
  }

  list(limit = 500) {
    return [...this.byJid.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(({ name, jid }) => ({ name, jid }));
  }

  // A corrupt or half-written cache must never stop the daemon booting - the
  // index is a convenience, the session is the thing that matters.
  load() {
    if (!this.filePath || !existsSync(this.filePath)) return 0;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      for (const e of raw.contacts || []) {
        if (e && e.jid && e.name) this.byJid.set(e.jid, { jid: e.jid, name: String(e.name) });
      }
    } catch {
      // ignore - we simply start from an empty index and rebuild on sync
    }
    return this.byJid.size;
  }

  // Debounced: a history sync fires thousands of upserts in a burst, and one
  // write per contact would hammer the disk for no benefit.
  _scheduleSave() {
    if (!this.filePath || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 2000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  save() {
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ contacts: [...this.byJid.values()] }), { mode: 0o600 });
    } catch {
      // a read-only or full disk must not take the daemon down
    }
  }

  resolve(query, limit = 20) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const entry of this.byJid.values()) {
      const name = entry.name.toLowerCase();
      let score;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.includes(q)) score = 2;
      else continue;
      scored.push({ ...entry, score });
    }
    scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return scored.slice(0, limit).map(({ name, jid }) => ({ name, jid }));
  }
}
