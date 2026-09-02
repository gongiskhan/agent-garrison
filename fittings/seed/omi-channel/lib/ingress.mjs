// Webhook ingress: auth (shared secret + pinned uid, invariant I8), fast-ack
// enqueue (I7), and the serialized normalization worker with dedupe (I6).
//
// Privacy (I5): realtime transcript payloads are NEVER enqueued, persisted, or
// logged with content - they are parsed in memory, counted, and handed to the
// realtime forwarder (lib/forward.mjs), which carries them to the voice layer.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { failedEvent, normalizeConversation, normalizeDaySummary } from "./normalize.mjs";
import { ulid } from "./store.mjs";

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

// Constant-time compare via fixed-length digests (no length leak).
export function secretMatches(presented, expected) {
  if (!presented || !expected) return false;
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

export class Ingress {
  constructor({ cfg, store, counters, forwarder = null, log = console }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    // The voice layer's door (D24). The wake gate and the echo guard run in
    // capture-service; this side only forwards. See lib/forward.mjs.
    this.forwarder = forwarder;
    this.log = log;
    this.chain = Promise.resolve();
  }

  // -> { ok: true, uid } | { ok: false, status, reason }
  authorize(query, pathname = "?") {
    if (!this.cfg.enabled) {
      this.counters.bump("rejected_disabled");
      return { ok: false, status: 403, reason: "ingress disabled" };
    }
    const expected = this.cfg.secrets.webhookSecret;
    if (!expected) {
      this.counters.bump("rejected_no_secret");
      return { ok: false, status: 403, reason: "ingress not configured" };
    }
    if (!secretMatches(query.key, expected)) {
      this.counters.bump("rejected_auth");
      // A rejected key is otherwise invisible: the counter says "someone was
      // turned away" but not whether the URL was truncated, double-encoded, or
      // simply absent - and that is exactly the difference between a config typo
      // and an attack. Shape only, never the value: length + first/last 2 chars
      // of BOTH sides, so a mismatch is diagnosable without printing a secret.
      const shape = (s) =>
        typeof s !== "string" || s.length === 0
          ? "<absent>"
          : `len=${s.length} ${s.slice(0, 2)}..${s.slice(-2)}`;
      // When the presented value merely has our secret plus a tail, the tail is
      // the interesting part and is NOT itself a secret (it is whatever the
      // sender glued on - a separator plus uid). Print it JSON-escaped so an
      // invisible separator (newline, tab, %26 left encoded) is actually
      // readable; inferring it from a length delta got the separator wrong once.
      const presented = typeof query.key === "string" ? query.key : "";
      const tail =
        typeof expected === "string" && expected && presented.startsWith(expected)
          ? ` trailing=${JSON.stringify(presented.slice(expected.length))}`
          : "";
      // The PATH is what makes this actionable: each Omi trigger is configured
      // with its own URL, so "which endpoint" IS "which field the human must fix".
      this.log.warn?.(
        `[omi-channel] rejected bad key on ${pathname}: presented ${shape(query.key)}; ` +
          `expected ${shape(expected)}; params=[${Object.keys(query).join(",")}]${tail}`
      );
      return { ok: false, status: 401, reason: "bad key" };
    }
    const uid = typeof query.uid === "string" ? query.uid.trim() : "";
    if (!uid) {
      this.counters.bump("rejected_no_uid");
      return { ok: false, status: 400, reason: "missing uid" };
    }
    const pinned = this.store.pinnedUid() ?? this.store.pinUid(uid);
    if (uid !== pinned) {
      this.counters.bump("rejected_uid");
      return { ok: false, status: 403, reason: "uid not allowed" };
    }
    return { ok: true, uid };
  }

  // Batch pipe: enqueue raw + schedule the drain. Returns fast (I7).
  accept({ kind, uid, bodyText, sessionId = null }) {
    this.store.enqueueRaw({
      kind,
      uid,
      sessionId,
      receivedAt: new Date().toISOString(),
      bodyText
    });
    this.counters.bump("webhooks_in");
    this.scheduleDrain();
  }

  scheduleDrain() {
    this.chain = this.chain.then(() => this.drain()).catch((err) => {
      this.log.error(`[omi-channel] drain error: ${err?.stack || err}`);
    });
    return this.chain;
  }

  // Serialized: one drain at a time; dedupe index read-modify-write is safe.
  async drain() {
    for (const file of this.store.listQueue()) {
      let entry = null;
      try {
        entry = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.store.removeQueued(file);
        continue;
      }
      try {
        this.processEntry(entry);
      } catch (err) {
        // Never lose an entry to a processing bug: mark failed with raw kept.
        this.log.error(`[omi-channel] normalize error: ${err?.stack || err}`);
        const id = ulid();
        const ev = failedEvent({
          id,
          uid: entry.uid,
          receivedAt: entry.receivedAt,
          kind: entry.kind,
          reason: `normalize error: ${err?.message ?? err}`
        });
        ev.raw_ref = this.store.writeRaw(id, { bodyText: entry.bodyText });
        this.store.writeEvent(ev);
        this.counters.bump("events_failed");
      }
      this.store.removeQueued(file);
    }
  }

  processEntry(entry) {
    const receivedAt = entry.receivedAt ?? new Date().toISOString();
    const index = this.store.readIndex();

    // Layer 1 dedupe (I6): raw-body fingerprint. Covers EVERY replayed
    // payload, including ones that never parse.
    const fingerprint = crypto.createHash("sha256").update(entry.bodyText ?? "", "utf8").digest("hex").slice(0, 32);
    if (index.byFingerprint[fingerprint]) {
      this.counters.bump("events_deduped");
      return;
    }

    let raw = null;
    try {
      raw = JSON.parse(entry.bodyText);
    } catch {
      const id = ulid();
      const ev = failedEvent({
        id,
        uid: entry.uid,
        receivedAt,
        kind: entry.kind,
        reason: "malformed JSON"
      });
      ev.raw_ref = this.store.writeRaw(id, { malformed: true, bodyText: entry.bodyText });
      this.store.writeEvent(ev);
      index.byFingerprint[fingerprint] = id;
      this.store.writeIndex(index);
      this.counters.bump("events_failed");
      return;
    }

    const id = ulid();
    const event =
      entry.kind === "day_summary"
        ? normalizeDaySummary({ id, uid: entry.uid, receivedAt, raw })
        : normalizeConversation({ id, uid: entry.uid, receivedAt, raw });

    // Layer 2 dedupe (I6): semantic identity - Omi conversation id for the
    // batch pipe, (source, "day", date) for summaries. Catches regenerated
    // payloads whose body text drifted but which name the same conversation.
    const semanticBucket = event.kind === "conversation" ? index.byConversation : index.byDay;
    const semanticKey =
      event.kind === "conversation" ? event.provenance.omi_conversation_id : event.day_key;
    if (semanticKey && semanticBucket[semanticKey]) {
      // Record the fingerprint too so future replays short-circuit at layer 1.
      index.byFingerprint[fingerprint] = semanticBucket[semanticKey];
      this.store.writeIndex(index);
      this.counters.bump("events_deduped");
      return;
    }

    event.raw_ref = this.store.writeRaw(id, raw);
    this.store.writeEvent(event);
    if (semanticKey) semanticBucket[semanticKey] = id;
    index.byFingerprint[fingerprint] = id;
    this.store.writeIndex(index);
    this.counters.bump("events_in");
    this.counters.bump(`events_in_${event.kind}`);
  }

  // Realtime pipe: content is parsed in memory and discarded - never
  // persisted, never logged (I5). When the wake flag is on, segments are
  // forwarded to the voice layer (capture-service) fire-and-forget; the webhook
  // ack never waits on that hop. Off, they only touch counters.
  acceptRealtime({ bodyText, sessionId = null }) {
    this.counters.bump("realtime_calls");
    try {
      const payload = JSON.parse(bodyText);
      // The docs promise a bare array of segments; live deliveries are not
      // always one, so accept the known envelopes too. `transcript_segments` is
      // the key the memory-creation payload uses, so Omi is not consistent
      // across triggers and we should not assume this list is complete —
      // anything unrecognised logs its SHAPE below (never its content, I5).
      const segments = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.segments)
          ? payload.segments
          : Array.isArray(payload?.transcript_segments)
            ? payload.transcript_segments
            : Array.isArray(payload?.data?.segments)
              ? payload.data.segments
              : null;
      // A session id can arrive on the query OR in the body; without one the
      // segments cannot be forwarded (the voice layer keys its session on it),
      // so a mangled URL that drops session_id would silently disable the
      // whole spoken path even once auth is repaired.
      const session =
        sessionId || payload?.session_id || payload?.sessionId || payload?.data?.session_id || null;
      if (segments) {
        this.counters.bump("realtime_segments", segments.length);
        if (!Array.isArray(payload)) this.counters.bump("realtime_enveloped");
        if (this.cfg.wakeEnabled && this.forwarder && session) {
          void this.forwarder.push({ sessionId: session, segments });
        } else if (this.cfg.wakeEnabled && this.forwarder && !session) {
          this.counters.bump("realtime_no_session_id");
        }
      } else {
        this.counters.bump("realtime_malformed");
        // Structure only: top-level type and KEY NAMES. Key names describe the
        // envelope, not the conversation, so this stays inside I5 while making
        // an unknown payload shape diagnosable instead of just counted.
        const shape =
          payload === null
            ? "null"
            : Array.isArray(payload)
              ? `array[${payload.length}]`
              : typeof payload === "object"
                ? `object keys=[${Object.keys(payload).join(",")}]`
                : typeof payload;
        this.log.warn?.(`[omi-channel] realtime payload not segments: ${shape}`);
      }
    } catch {
      this.counters.bump("realtime_malformed");
      this.log.warn?.(
        `[omi-channel] realtime payload unparseable as JSON (bytes=${bodyText?.length ?? 0})`
      );
    }
  }
}
