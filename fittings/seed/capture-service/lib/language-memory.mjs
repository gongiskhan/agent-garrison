// Which language were we last speaking? (2026-08-28)
//
// The user's own framing: say "Sim?" or "Yes?" depending on "if last time we
// spoke in english or a reply was in english". A cue is one or two words - far
// too little text to detect a language from - so the cue has to inherit the
// language of the conversation rather than derive it from itself.
//
// What feeds this is the part that decides whether it works. ONLY text directed
// at Zeca counts: a segment carrying the wake word, or any segment arriving
// while the capture window is open. The pendant hears an English television all
// evening, and if that fed the memory the cue would flip language in an empty
// room and stay wrong for hours.
//
// Persisted, because up() restarts are routine and a forgotten language
// silently reverts the cue to the default. It is a two-letter code with a
// timestamp - no transcript, no content, nothing that touches I5.

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJSON } from "./store.mjs";
import { detectLanguage, isLanguage } from "./lang.mjs";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h - stickiness, not a per-utterance flip

export class LanguageMemory {
  constructor({ stateDir, cfg = {}, counters = null, now = () => Date.now(), log = console }) {
    this.file = path.join(stateDir, "language.json");
    this.cfg = cfg;
    this.counters = counters;
    this.now = now;
    this.log = log;
    this.ttlMs = cfg.languageMemoryTtlMs ?? DEFAULT_TTL_MS;
    this.sessions = new Map(); // sessionId -> { lang, at }
    this.global = null; // { lang, at }
    this.capturing = new Set();
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      if (isLanguage(doc?.lang) && typeof doc?.at === "number") this.global = { lang: doc.lang, at: doc.at };
    } catch {
      /* a corrupt memory is just an absent one */
    }
  }

  // Written only when the value actually CHANGES: this is on the segment path,
  // which runs several times a second while someone is talking.
  persist() {
    try {
      atomicWriteJSON(this.file, { lang: this.global?.lang ?? null, at: this.global?.at ?? null });
    } catch (err) {
      this.log?.error?.(`[capture-service] language memory write failed: ${err?.message ?? err}`);
    }
  }

  markCapturing(sessionId, open) {
    if (!sessionId) return;
    if (open) this.capturing.add(sessionId);
    else this.capturing.delete(sessionId);
  }

  isCapturing(sessionId) {
    return this.capturing.has(sessionId);
  }

  // Record a language observation. `text` that detects as undetermined is
  // ignored entirely rather than counted as a vote for the default - that is
  // what stops one "ok" from flipping a confident value.
  note(sessionId, text) {
    return this.noteLanguage(sessionId, detectLanguage(text));
  }

  // Record a language that something else already resolved - the ack layer
  // decides one per ack, and re-deriving it from the rendered sentence would be
  // strictly worse evidence than the answer it already has.
  noteLanguage(sessionId, lang) {
    if (!isLanguage(lang)) return null;
    const at = this.now();
    if (sessionId) this.sessions.set(sessionId, { lang, at });
    const changed = this.global?.lang !== lang;
    this.global = { lang, at };
    if (changed) {
      this.counters?.bump?.(`language_switched_${lang}`);
      this.persist();
    }
    return lang;
  }

  fresh(entry) {
    return entry && this.now() - entry.at < this.ttlMs ? entry.lang : null;
  }

  // This session, then whatever was last heard anywhere (so the first wake of a
  // brand-new session is still right), then configuration, then Portuguese.
  current(sessionId = null) {
    const explicit = this.cfg.voiceLanguage;
    if (isLanguage(explicit)) return explicit;
    return (
      this.fresh(this.sessions.get(sessionId)) ??
      this.fresh(this.global) ??
      (isLanguage(this.cfg.wakeLanguage) ? this.cfg.wakeLanguage : "pt")
    );
  }
}
