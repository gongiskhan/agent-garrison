// Feedback event bus (Pendant Direct, ADR D7/D8).
//
// Five lifecycle events - wake_detected, segment_captured, window_closed,
// task_created, task_failed - emitted by the pendant wake path (the shared
// WakeBus's inert onLifecycle hook plus the interim wake watcher) and fanned
// out to whoever subscribed: the session socket pusher (which drives the
// device haptic and the phone sinks through the Companion) and any live view.
//
// Latency accounting: every emitted event is held (bounded, TTL-pruned) until
// the Companion's {type:"feedback_ack", event_id} receipt arrives on the
// session socket; the delta lands in the two headline metrics -
// wake_to_device_ack_ms and card_commit_to_created_ack_ms - via the standard
// counters.observe mechanism, so /health carries _last/_sum/_count.
//
// wake_detected dedupe: the interim watcher fires early (feedback-only,
// ADR D8) and the WakeBus fires again on the final segment. The first one
// through opens a per-session wake window here; a second wake_detected while
// that window is open is swallowed, so the wearer feels exactly one pulse per
// wake. window_closed closes the window; a TTL covers the
// interim-hit-that-never-finalizes case.
//
// Log privacy (I5): events carry ids, names, reasons and timestamps - never
// transcript text.

import { ulid } from "./store.mjs";

export const FEEDBACK_EVENT_NAMES = [
  "wake_detected",
  "segment_captured",
  "window_closed",
  "task_created",
  "task_failed"
];

const PENDING_ACK_TTL_MS = 5 * 60 * 1000;
const RECENT_EVENTS_CAP = 100;

export class FeedbackBus {
  constructor({ counters, log = console, now = () => Date.now(), wakeWindowTtlMs = 30000 }) {
    this.counters = counters;
    this.log = log;
    this.now = now;
    this.wakeWindowTtlMs = wakeWindowTtlMs;
    this.subscribers = new Set(); // fn(event)
    this.sessionSubscribers = new Map(); // sessionId -> Set<fn>
    this.pendingAcks = new Map(); // event_id -> {name, emittedAtMs}
    this.recent = new Map(); // sessionId -> [event]
    this.openWakeWindows = new Map(); // sessionId -> openedAtMs
  }

  emit(name, payload = {}) {
    if (!FEEDBACK_EVENT_NAMES.includes(name)) return null;
    const sessionId = payload.sessionId ?? payload.session_id ?? null;
    if (!sessionId) return null;
    const atMs = typeof payload.at === "number" ? payload.at : this.now();

    if (name === "wake_detected") {
      const openedAt = this.openWakeWindows.get(sessionId);
      if (openedAt !== undefined && atMs - openedAt < this.wakeWindowTtlMs) {
        this.counters.bump("feedback_wake_deduped");
        return null;
      }
      this.openWakeWindows.set(sessionId, atMs);
    }
    if (name === "window_closed") this.openWakeWindows.delete(sessionId);

    const event = {
      event_id: ulid(),
      name,
      session_id: sessionId,
      at: new Date(atMs).toISOString(),
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      ...(payload.cardId !== undefined ? { card_id: payload.cardId } : {}),
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.interim ? { interim: true } : {})
    };

    this.pendingAcks.set(event.event_id, { name, emittedAtMs: atMs });
    this.prunePendingAcks(atMs);

    const ring = this.recent.get(sessionId) ?? [];
    ring.push(event);
    if (ring.length > RECENT_EVENTS_CAP) ring.splice(0, ring.length - RECENT_EVENTS_CAP);
    this.recent.set(sessionId, ring);

    this.counters.bump(`feedback_${name}`);
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        this.log.error(`[capture-service] feedback subscriber error: ${err?.message ?? err}`);
      }
    }
    for (const fn of this.sessionSubscribers.get(sessionId) ?? []) {
      try {
        fn(event);
      } catch {}
    }
    return event;
  }

  // The Companion's receipt off the session socket. Closes the latency
  // measurement for the event it names; unknown ids are counted, not errors
  // (a late ack after the TTL prune is honest noise).
  recordDeviceAck(eventId, { atMs = null } = {}) {
    const pending = this.pendingAcks.get(String(eventId ?? ""));
    if (!pending) {
      this.counters.bump("feedback_acks_unknown");
      return null;
    }
    this.pendingAcks.delete(String(eventId));
    const ackAt = typeof atMs === "number" ? atMs : this.now();
    const latency = Math.max(0, ackAt - pending.emittedAtMs);
    this.counters.bump("feedback_acks");
    if (pending.name === "wake_detected") {
      this.counters.observe("wake_to_device_ack_ms", latency);
    } else if (pending.name === "task_created") {
      this.counters.observe("card_commit_to_created_ack_ms", latency);
    } else {
      this.counters.observe("feedback_ack_ms", latency);
    }
    return { name: pending.name, latencyMs: latency };
  }

  subscribeAll(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  subscribe(sessionId, fn) {
    const set = this.sessionSubscribers.get(sessionId) ?? new Set();
    set.add(fn);
    this.sessionSubscribers.set(sessionId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.sessionSubscribers.delete(sessionId);
    };
  }

  recentEvents(sessionId) {
    return (this.recent.get(sessionId) ?? []).slice();
  }

  prunePendingAcks(nowMs) {
    for (const [id, entry] of this.pendingAcks) {
      if (nowMs - entry.emittedAtMs > PENDING_ACK_TTL_MS) this.pendingAcks.delete(id);
    }
    for (const [sessionId, openedAt] of this.openWakeWindows) {
      if (nowMs - openedAt > this.wakeWindowTtlMs) this.openWakeWindows.delete(sessionId);
    }
  }
}
