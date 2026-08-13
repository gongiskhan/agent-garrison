// Capture service durable state — file-per-record under $GARRISON_HOME/capture
// (override GARRISON_CAPTURE_DIR), kanban-loop conventions: atomic
// temp-then-rename writes, a rebuildable dedupe index, no databases.
//
// Layout (grows per milestone; M0 creates the roots):
//   sessions/<sessionId>.json      session record (mode, consent, device,
//                                  timing, seq high-water marks, status)
//   transcripts/<sessionId>.json   final transcript segments (M2)
//   media/<sessionId>/             audio.log + audio.idx, frames/<seq>.jpg (M1)
//   events/<id>.json               capture_event records (shared triage
//                                  contract — same layout as the omi store)
//   index.json                     dedupe index
//   devices.json                   APNs device-token registry (M5)
//   notify-ledger.json             per-day push cap ledger (M5)
//   counters-<name>.json           per-writer counters
//
// The ulid/atomic-write/Counters primitives are copied from
// omi-channel/lib/store.mjs (cross-fitting imports are forbidden; the store
// LAYOUT is the sharing contract the generalized triage tick reads).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { captureDir } from "./config.mjs";

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

export class CaptureStore {
  constructor(root = captureDir()) {
    this.root = root;
    this.dirs = {
      sessions: path.join(root, "sessions"),
      transcripts: path.join(root, "transcripts"),
      media: path.join(root, "media"),
      events: path.join(root, "events")
    };
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true });
    this.indexFile = path.join(root, "index.json");
    this.devicesFile = path.join(root, "devices.json");
  }

  // ---- capture_event store (shared triage contract; grows at M1/M4) ----
  writeEvent(event) {
    atomicWriteJSON(path.join(this.dirs.events, `${event.id}.json`), event);
    return event.id;
  }

  getEvent(id) {
    return readJSON(path.join(this.dirs.events, `${id}.json`));
  }

  listEvents(status = null) {
    return readdirSync(this.dirs.events)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => readJSON(path.join(this.dirs.events, f)))
      .filter((e) => e && (status === null || e.status === status));
  }

  updateEvent(id, patch) {
    const event = this.getEvent(id);
    if (!event) return null;
    const next = { ...event, ...patch };
    this.writeEvent(next);
    return next;
  }

  removeSessionMedia(sessionId) {
    rmSync(path.join(this.dirs.media, sessionId), { recursive: true, force: true });
  }
}

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

  // Gauge-style set (e.g. last observed latency). Merged like any counter.
  set(key, value) {
    const counters = this.read();
    counters[key] = value;
    counters.updatedAt = new Date().toISOString();
    atomicWriteJSON(this.file, counters);
    return value;
  }

  // Observation helper: records <key>_last / _sum / _count so /health can
  // show both the latest value and a computable average.
  observe(key, value) {
    const counters = this.read();
    counters[`${key}_last`] = value;
    counters[`${key}_sum`] = (counters[`${key}_sum`] ?? 0) + value;
    counters[`${key}_count`] = (counters[`${key}_count`] ?? 0) + 1;
    counters.updatedAt = new Date().toISOString();
    atomicWriteJSON(this.file, counters);
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
