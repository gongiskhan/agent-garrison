// Omi channel durable state — file-per-record under $GARRISON_HOME/omi
// (override GARRISON_OMI_DIR), kanban-loop conventions: atomic
// temp-then-rename writes, a rebuildable dedupe index, no databases.
//
// Layout:
//   raw-queue/<ulid>.json   raw webhook payloads awaiting normalization
//   raw/<eventId>.json      raw payload preserved per capture_event (I6/I1
//                           evidence; conversations + day summaries ONLY,
//                           never realtime segments - invariant I5)
//   events/<eventId>.json   capture_event records
//   index.json              dedupe index {byConversation, byDay}
//   state.json              {pinnedUid, pinnedAt}
//   counters-<name>.json    per-writer counters (server vs triage processes)

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { omiDir } from "./config.mjs";

// --- ulid (Crockford base32, time-prefixed, lexically sortable). No deps. ---
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRand = null;
export function ulid(now = Date.now()) {
  let time = now;
  let rand;
  if (time === lastTime && lastRand) {
    // monotonic within the same ms: increment the random part
    rand = [...lastRand];
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) {
        rand[i]++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = Array.from(crypto.randomBytes(16), (b) => b % 32).slice(0, 16);
  }
  lastTime = time;
  lastRand = rand;
  let ts = "";
  for (let i = 9; i >= 0; i--) {
    ts = B32[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  return ts + rand.map((v) => B32[v]).join("");
}

export function atomicWriteJSON(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export class OmiStore {
  constructor(root = omiDir()) {
    this.root = root;
    this.dirs = {
      rawQueue: path.join(root, "raw-queue"),
      raw: path.join(root, "raw"),
      events: path.join(root, "events")
    };
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true });
    this.indexFile = path.join(root, "index.json");
    this.stateFile = path.join(root, "state.json");
  }

  // ---- pinned uid (invariant I8: single uid, captured on first valid call) ----
  readState() {
    return readJSON(this.stateFile, {});
  }

  pinnedUid() {
    return this.readState().pinnedUid ?? null;
  }

  pinUid(uid) {
    const state = this.readState();
    if (state.pinnedUid) return state.pinnedUid;
    atomicWriteJSON(this.stateFile, { ...state, pinnedUid: uid, pinnedAt: new Date().toISOString() });
    return uid;
  }

  // ---- raw queue (ingress writes, worker drains) ----
  enqueueRaw(entry) {
    const id = ulid();
    atomicWriteJSON(path.join(this.dirs.rawQueue, `${id}.json`), { queueId: id, ...entry });
    return id;
  }

  listQueue() {
    return readdirSync(this.dirs.rawQueue)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => path.join(this.dirs.rawQueue, f));
  }

  removeQueued(file) {
    rmSync(file, { force: true });
  }

  // ---- dedupe index (I6). Rebuildable by scanning events/. ----
  readIndex() {
    const index = readJSON(this.indexFile, {});
    return {
      byConversation: index.byConversation ?? {},
      byDay: index.byDay ?? {},
      // Raw-body fingerprints: the dedupe layer that also covers payloads that
      // never parsed (I6 - replaying ANY payload twice is a no-op). Not
      // rebuildable from events/ (the original body text is gone for deduped
      // entries); rebuildIndex leaves it empty and the semantic keys still
      // protect.
      byFingerprint: index.byFingerprint ?? {}
    };
  }

  writeIndex(index) {
    atomicWriteJSON(this.indexFile, index);
  }

  rebuildIndex() {
    const index = { byConversation: {}, byDay: {}, byFingerprint: {} };
    for (const ev of this.listEvents()) {
      if (ev.provenance?.omi_conversation_id) index.byConversation[ev.provenance.omi_conversation_id] = ev.id;
      if (ev.kind === "day_summary" && ev.day_key) index.byDay[ev.day_key] = ev.id;
    }
    this.writeIndex(index);
    return index;
  }

  // ---- capture events ----
  eventFile(id) {
    return path.join(this.dirs.events, `${id}.json`);
  }

  writeEvent(event) {
    atomicWriteJSON(this.eventFile(event.id), event);
    return event;
  }

  writeRaw(eventId, raw) {
    const file = path.join(this.dirs.raw, `${eventId}.json`);
    atomicWriteJSON(file, raw);
    return path.relative(this.root, file);
  }

  getEvent(id) {
    return readJSON(this.eventFile(id));
  }

  listEvents(status = null) {
    const out = [];
    for (const f of readdirSync(this.dirs.events).filter((f) => f.endsWith(".json")).sort()) {
      const ev = readJSON(path.join(this.dirs.events, f));
      if (ev && (!status || ev.status === status)) out.push(ev);
    }
    return out;
  }

  updateEvent(id, mutate) {
    const ev = this.getEvent(id);
    if (!ev) return null;
    const next = mutate({ ...ev });
    this.writeEvent(next);
    return next;
  }
}

// ---- counters. Per-writer file so the server and the triage CLI never race.
export class Counters {
  constructor(root, name) {
    this.file = path.join(root, `counters-${name}.json`);
  }

  read() {
    return readJSON(this.file, {});
  }

  bump(key, by = 1) {
    const counters = this.read();
    counters[key] = (counters[key] ?? 0) + by;
    counters.updatedAt = new Date().toISOString();
    atomicWriteJSON(this.file, counters);
    return counters[key];
  }
}

export function mergedCounters(root) {
  const out = {};
  if (!existsSync(root)) return out;
  for (const f of readdirSync(root).filter((f) => f.startsWith("counters-") && f.endsWith(".json"))) {
    const c = readJSON(path.join(root, f), {});
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}
