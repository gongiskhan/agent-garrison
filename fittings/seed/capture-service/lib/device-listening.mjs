import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJSON, ulid } from "./store.mjs";
import { LISTENING_REASONS, STALL_AFTER_SECONDS, STALL_PUSH_MAX_PER_EPISODE,
  STALL_PUSH_REPEAT_MINUTES, WATCHDOG_TICK_SECONDS } from "./listening-config.mjs";

const SOURCES = new Set(["phone", "pendant"]);
const ACTUAL = new Set(["off", "starting", "listening", "interrupted", "failed"]);
const key = (device, source) => `${device}/${source}`;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Additive CaptureStore migration. Corrupt or future records stop startup;
// neither a parse failure nor an unknown version can silently reset intent.
export function migrateListeningStore(file) {
  let doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 0, records: {} };
  if (doc.version === 0) {
    doc = { ...doc, version: 1, records: doc.records ?? {}, episodes: {}, deliveries: {} };
    atomicWriteJSON(file, doc);
  }
  if (doc.version !== 1 || !doc.records || !doc.episodes || !doc.deliveries) {
    throw new Error("Unsupported device_listening store");
  }
  return doc;
}

export class DeviceListening {
  constructor({ store, notifier, now = () => Date.now(), log = console, operative = () => "Zeca" }) {
    this.file = path.join(store.root, "device_listening.json");
    this.doc = migrateListeningStore(this.file);
    this.notifier = notifier;
    this.now = now;
    this.log = log;
    this.operative = operative;
    this.listeners = new Set();
    this.ticking = false;
  }
  list(device) { return Object.values(this.doc.records).filter(r => !device || r.device_id === device).map(r => ({ ...r })); }
  get(device, source) { const r = this.doc.records[key(device, source)]; return r ? { ...r } : null; }
  save() { atomicWriteJSON(this.file, this.doc); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(record) {
    for (const fn of this.listeners) {
      try { fn({ type: "listening.state", ...record }); } catch (err) { this.log.error(`listening subscriber: ${err.message}`); }
    }
  }
  changed(record, previous) {
    this.log.log(`listening ${record.device_name}/${record.source} ${previous.actual} -> ${record.actual} (${record.reason})`);
    this.emit(record);
  }
  register(device, source, metadata = {}) {
    if (!/^[a-zA-Z0-9-]{10,80}$/.test(device ?? "") || !SOURCES.has(source)) fail(400, "Invalid listening identity");
    const id = key(device, source);
    if (!this.doc.records[id]) {
      const at = new Date(this.now()).toISOString();
      this.doc.records[id] = { device_id: device, device_name: String(metadata.device_name ?? "iPhone").replace(/[\r\n]/g, " ").slice(0, 64),
        source, intent: "off", actual: "off", reason: null, last_seen_at: null,
        intent_changed_at: at, actual_changed_at: at, stall_episode_id: null, stall_pushes_sent: 0,
        app_version: String(metadata.app_version ?? "").slice(0, 64) };
      this.save();
    }
    return this.get(device, source);
  }
  clearEpisode(r) {
    if (r.stall_episode_id) delete this.doc.episodes[r.stall_episode_id];
    r.stall_episode_id = null;
    r.stall_pushes_sent = 0;
  }
  message(owner, msg) {
    if (!owner || owner !== msg.device_id) fail(403, "Listening device does not own this channel");
    const current = this.get(owner, msg.source);
    if (!current) fail(404, "Listening source is not registered");
    const r = this.doc.records[key(owner, msg.source)];
    const at = new Date(this.now()).toISOString();
    if (msg.type === "listening.intent") {
      if (!["off", "listening"].includes(msg.intent)) fail(400, "Invalid listening intent");
      const changes = [];
      if (msg.intent === "listening") {
        for (const other of Object.values(this.doc.records)) {
          if (other.device_id === owner && other.source !== r.source && (other.intent !== "off" || other.actual !== "off")) {
            const old = { ...other };
            Object.assign(other, { intent: "off", actual: "off", reason: "source_switch", intent_changed_at: at, actual_changed_at: at });
            this.clearEpisode(other);
            changes.push([other, old]);
          }
        }
      }
      r.intent = msg.intent;
      r.intent_changed_at = at;
      r.actual = msg.intent === "off" ? "off" : "starting";
      r.actual_changed_at = at;
      r.reason = msg.intent === "off" ? "user_stop" : "user_start";
      if (msg.intent === "off") this.clearEpisode(r);
      changes.push([r, current]);
      this.save(); // Source switch is one atomic write before any observer fires.
      for (const [next, prev] of changes) this.changed(next, prev);
      return this.get(owner, msg.source);
    }
    if (msg.type === "listening.heartbeat") return this.activity(owner, msg.source);
    if (msg.type !== "listening.transition" || !ACTUAL.has(msg.actual) || !LISTENING_REASONS.has(msg.reason) || msg.reason.startsWith("watchdog_")) fail(400, "Invalid listening transition");
    if (r.intent === "off") return current;
    r.actual = msg.actual;
    r.reason = msg.reason;
    r.actual_changed_at = at;
    if (r.actual === "listening") {
      r.last_seen_at = at;
      if (r.stall_episode_id) { r.reason = "watchdog_recovered"; this.clearEpisode(r); }
    }
    this.save();
    this.changed(r, current);
    return this.get(owner, msg.source);
  }
  activity(device, source) {
    const r = this.doc.records[key(device, source)];
    if (!r || r.intent !== "listening") return r ? { ...r } : null;
    const previous = { ...r };
    r.last_seen_at = new Date(this.now()).toISOString();
    if (r.stall_episode_id) {
      r.actual = "listening";
      r.reason = "watchdog_recovered";
      r.actual_changed_at = r.last_seen_at;
      this.clearEpisode(r);
      this.save();
      this.changed(r, previous);
    } else {
      // Persist at heartbeat cadence, not once per 20 ms audio packet.
      if (!this.lastFlush || this.now() - this.lastFlush >= WATCHDOG_TICK_SECONDS * 1000) { this.save(); this.lastFlush = this.now(); this.emit(r); }
    }
    return { ...r };
  }
  wake(device, source, at = this.now()) {
    const r = this.get(device, source);
    if (!r || r.intent !== "listening") return;
    for (const fn of this.listeners) fn({ type: "wake.detected", device_id: device, source, at: new Date(at).toISOString() });
  }
  start() {
    this.timer ??= setInterval(() => void this.tick().catch(e => this.log.error(`listening watchdog: ${e.message}`)), WATCHDOG_TICK_SECONDS * 1000);
    this.timer.unref?.();
  }
  close() { clearInterval(this.timer); this.timer = null; this.save(); }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const r of Object.values(this.doc.records)) {
        if (r.intent !== "listening") continue;
        const last = Math.max(Date.parse(r.last_seen_at ?? r.intent_changed_at), Date.parse(r.intent_changed_at));
        if (!r.stall_episode_id && this.now() - last >= STALL_AFTER_SECONDS * 1000) {
          const previous = { ...r };
          r.actual = "stalled";
          r.reason = "watchdog_stalled";
          r.actual_changed_at = new Date(this.now()).toISOString();
          r.stall_episode_id = ulid(this.now());
          r.stall_pushes_sent = 0;
          this.doc.episodes[r.stall_episode_id] = this.now();
          this.save();
          this.changed(r, previous);
        }
        const episode = r.stall_episode_id;
        if (!episode || r.stall_pushes_sent >= STALL_PUSH_MAX_PER_EPISODE) continue;
        if (r.stall_pushes_sent && this.now() - this.doc.episodes[episode] < STALL_PUSH_REPEAT_MINUTES * 60_000) continue;
        const ordinal = r.stall_pushes_sent + 1;
        const delivery = `${episode}/${ordinal}`;
        // Reserve before delivery. A crash or uncertain APNs response must
        // not cause this same notification to be delivered twice.
        if (this.doc.deliveries[delivery]) continue;
        this.doc.deliveries[delivery] = new Date(this.now()).toISOString();
        r.stall_pushes_sent = ordinal;
        this.save();
        this.emit(r);
        const phone = r.source === "phone";
        await this.notifier.sendListeningPush({
          title: `${this.operative()} ${phone ? "stopped listening" : "lost the pendant"}`,
          body: phone ? "The phone microphone stopped sending audio. Tap to resume." : "No audio from the pendant for 20 seconds. Tap to reconnect.",
          path: `/capture?source=${r.source}`, tag: `listening-${delivery}`,
          device_id: r.device_id, idempotencyKey: delivery
        });
      }
    } finally { this.ticking = false; }
  }
}
