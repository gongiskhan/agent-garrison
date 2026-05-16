// Channel SSE multiplexer. Each channel id holds a Set of SessionState
// references; events from any registered session republish to every
// subscriber on the matching channel.

import { logEvent } from "./log.mjs";

const RING_BUFFER_SIZE = 100;

export class ChannelHub {
  constructor() {
    /** @type {Map<string, { subscribers: Set<(ev: any) => void>, ring: any[] }>} */
    this.channels = new Map();
    /** @type {Map<string, string>} */ // sessionId → channelId
    this.sessionToChannel = new Map();
  }

  ensure(channelId) {
    let entry = this.channels.get(channelId);
    if (!entry) {
      entry = { subscribers: new Set(), ring: [] };
      this.channels.set(channelId, entry);
    }
    return entry;
  }

  bindSession(sessionId, channelId) {
    this.sessionToChannel.set(sessionId, channelId);
    this.ensure(channelId);
  }

  unbindSession(sessionId) {
    this.sessionToChannel.delete(sessionId);
  }

  channelFor(sessionId) {
    return this.sessionToChannel.get(sessionId);
  }

  publish(sessionId, soul, event) {
    const channelId = this.sessionToChannel.get(sessionId);
    if (!channelId) return;
    const entry = this.ensure(channelId);
    const wrapped = { session_id: sessionId, soul, event };
    entry.ring.push(wrapped);
    if (entry.ring.length > RING_BUFFER_SIZE) {
      entry.ring.splice(0, entry.ring.length - RING_BUFFER_SIZE);
    }
    for (const sub of entry.subscribers) {
      try { sub(wrapped); } catch (err) {
        logEvent("stderr", { kind: "channel-publish-failed", error: err.message });
      }
    }
  }

  subscribe(channelId, handler) {
    const entry = this.ensure(channelId);
    for (const wrapped of entry.ring) {
      try { handler(wrapped); } catch { /* ignore replay errors */ }
    }
    entry.subscribers.add(handler);
    return () => entry.subscribers.delete(handler);
  }

  list() {
    return Array.from(this.channels.entries()).map(([id, entry]) => ({
      id,
      subscriberCount: entry.subscribers.size,
      ringCount: entry.ring.length
    }));
  }
}
