// Runtime-neutral, in-process live event streams.
//
// A producer starts a keyed stream, appends named SSE frames, and settles it.
// Consumers atomically receive the buffered prefix and subscribe to future frames,
// so replay cannot race with follow. The registry knows nothing about Claude, the
// Agent SDK, PTYs, or chat chunks: future runtimes can publish the same named-event
// contract without changing the continuity layer.

const DEFAULT_MAX_FRAMES = 2_048;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function frameBytes(frame) {
  return Buffer.byteLength(frame.event, "utf8") + Buffer.byteLength(frame.data, "utf8") + 32;
}

function cleanEventName(value) {
  const event = String(value ?? "message").trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(event) ? event : "message";
}

function cleanData(value) {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value ?? {});
  return typeof encoded === "string" ? encoded : "{}";
}

export class LiveEventStreamRegistry {
  constructor({ maxFrames = DEFAULT_MAX_FRAMES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.maxFrames = Math.max(1, Math.trunc(maxFrames));
    this.maxBytes = Math.max(1_024, Math.trunc(maxBytes));
    this.streams = new Map();
  }

  start(key, at = new Date().toISOString()) {
    if (!key) return null;
    // A second producer for the same key supersedes the first one. End old
    // followers explicitly instead of leaving them attached to an orphan stream.
    this.finish(key, "superseded");
    const stream = {
      at,
      nextId: 1,
      bytes: 0,
      frames: [],
      subscribers: new Set(),
    };
    this.streams.set(key, stream);
    return stream;
  }

  append(key, input) {
    const stream = this.streams.get(key);
    if (!stream) return null;
    const frame = {
      id: stream.nextId++,
      event: cleanEventName(input?.event),
      data: cleanData(input?.data),
    };
    const bytes = frameBytes(frame);
    stream.frames.push(frame);
    stream.bytes += bytes;
    // Bounded best-effort replay. A single very large valid frame is retained
    // whole (never truncate JSON into an invalid payload); older frames yield.
    while (
      stream.frames.length > 1 &&
      (stream.frames.length > this.maxFrames || stream.bytes > this.maxBytes)
    ) {
      const removed = stream.frames.shift();
      stream.bytes -= frameBytes(removed);
    }
    for (const subscriber of [...stream.subscribers]) {
      try { subscriber.onFrame(frame); } catch { /* one client cannot break the turn */ }
    }
    return frame;
  }

  /**
   * Atomically capture the buffered prefix and attach a follower. JavaScript does
   * not yield inside this method, so no append can land between those two actions.
   */
  subscribe(key, { onFrame, onEnd } = {}) {
    const stream = this.streams.get(key);
    if (!stream) return null;
    const subscriber = {
      onFrame: typeof onFrame === "function" ? onFrame : () => {},
      onEnd: typeof onEnd === "function" ? onEnd : () => {},
    };
    const snapshot = stream.frames.map((frame) => ({ ...frame }));
    stream.subscribers.add(subscriber);
    let subscribed = true;
    return {
      at: stream.at,
      frames: snapshot,
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        stream.subscribers.delete(subscriber);
      },
    };
  }

  finish(key, reason = "settled") {
    const stream = this.streams.get(key);
    if (!stream) return false;
    this.streams.delete(key);
    for (const subscriber of [...stream.subscribers]) {
      try { subscriber.onEnd(reason); } catch { /* one client cannot break cleanup */ }
    }
    stream.subscribers.clear();
    return true;
  }

  since(key) {
    return this.streams.get(key)?.at ?? null;
  }

  keys() {
    return [...this.streams.keys()];
  }

  frames(key) {
    return this.streams.get(key)?.frames.map((frame) => ({ ...frame })) ?? [];
  }
}

/** Incremental SSE block decoder used by the upstream tee. Data lines retain
 * their content (joined with a newline per the SSE spec); CRLF and split chunks
 * are accepted. */
export class SseFrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = decodeSseBlock(block);
      if (frame) this.onFrame(frame);
    }
  }
}

export function decodeSseBlock(block) {
  let event = "message";
  const data = [];
  let id = null;
  for (const line of String(block ?? "").split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = cleanEventName(value);
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
  }
  if (event === "message" && data.length === 0 && id === null) return null;
  return { event, data: data.join("\n"), ...(id !== null ? { sourceId: id } : {}) };
}

export function formatSseFrame(frame) {
  const lines = [`id: ${frame.id}`, `event: ${cleanEventName(frame.event)}`];
  const dataLines = String(frame.data ?? "").split("\n");
  for (const line of dataLines) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}
