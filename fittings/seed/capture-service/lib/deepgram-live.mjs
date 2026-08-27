// Deepgram live transcription lane (M2).
//
// One Deepgram websocket per live session, fed raw Opus packets in seq order
// by the ingress (the media log's persist hook — frames reach this lane
// exactly once, in order, already deduped). Interim results live in memory
// for the live view; finals accumulate and are written to
// transcripts/<sessionId>.json when the session ends.
//
// Cost gate (invariant I4): a connection exists only while a session is live
// and the flag + key are present — STT is billed only during a session.
// Log privacy (invariant I5): nothing here logs transcript text; counters
// carry counts and reasons only.
//
// The websocket constructor is injectable (cfg.wsFactory in tests) so the
// suite runs against a local mock; the env-gated smoke script talks to the
// real endpoint with the same code.

import WebSocket from "ws";
import { normalizeOpusPacket } from "./opus-normalize.mjs";

const KEEPALIVE_MS = 5000;
const CLOSE_FLUSH_TIMEOUT_MS = 3000;
const RECONNECT_DELAY_MS = 1000;
const FEED_QUEUE_MAX = 1024; // ~20s of 20ms packets buffered across a reconnect

export function deepgramUrl(cfg) {
  const params = new URLSearchParams({
    model: cfg.sttModel,
    language: cfg.sttLanguage,
    encoding: "opus",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    // 300ms silence finalization (deepgram-voice's proven value): finals land
    // fast enough for the wake gate without splitting mid-clause.
    endpointing: "300"
  });
  // diarize is deliberately ABSENT: on real phone-mic captures it split the
  // one speaker into two, measurably changed nothing about accuracy, and the
  // param form we used (diarize=true) is deprecated (2026-08-13 forensics).
  // Without it every segment carries speaker null -> is_user true, which is
  // the truth for a single-mic companion session.
  for (const term of cfg.sttKeyterms ?? []) params.append("keyterm", term);
  // cfg.dgBaseUrl is the sandboxed-E2E mock redirect (env-only test hook);
  // production always resolves to the real endpoint.
  const base = cfg.dgBaseUrl || "wss://api.deepgram.com";
  return `${base.replace(/\/$/, "")}/v1/listen?${params}`;
}

// One Results frame -> one segment in the shape the wake bus and triage
// already consume ({start, end, text, is_user, speaker}).
export function segmentFromResults(msg) {
  const alt = msg?.channel?.alternatives?.[0];
  const text = (alt?.transcript ?? "").trim();
  if (!text) return null;
  const speaker = alt?.words?.find((w) => w.speaker !== undefined)?.speaker ?? null;
  return {
    start: msg.start ?? 0,
    end: (msg.start ?? 0) + (msg.duration ?? 0),
    text,
    speaker,
    // Heuristic: the session owner is normally the dominant first speaker on
    // a phone mic. Used only to LABEL classifier context, never to gate.
    is_user: speaker === null || speaker === 0,
    final: Boolean(msg.is_final),
    // Stored for observability (transcripts are data, not logs — I5 applies
    // to logs/counters only): lets a bad session be triaged by confidence
    // without replaying audio.
    confidence: typeof alt?.confidence === "number" ? alt.confidence : null
  };
}

class SessionTranscription {
  constructor(lane, sessionId) {
    this.lane = lane;
    this.sessionId = sessionId;
    this.segments = []; // finals only
    this.listeners = new Set(); // live-view subscribers
    this.queue = []; // Buffers awaiting an open socket
    this.ws = null;
    this.open = false;
    this.ended = false;
    this.lastAudioAt = 0;
    this.keepalive = null;
    this.reconnectTimer = null;
    this.connect();
  }

  connect() {
    const { cfg, counters, log } = this.lane;
    let ws;
    try {
      ws = this.lane.wsFactory(deepgramUrl(cfg), {
        headers: { authorization: `Token ${cfg.secrets.deepgramApiKey}` }
      });
    } catch (err) {
      counters.bump("transcribe_connect_failed");
      log.error(`[capture-service] deepgram connect failed: ${err?.message ?? err}`);
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ended) {
        try {
          ws.close();
        } catch {}
        return;
      }
      this.open = true;
      counters.bump("transcribe_connects");
      for (const bytes of this.queue.splice(0)) ws.send(bytes);
      this.keepalive = setInterval(() => {
        if (this.open && Date.now() - this.lastAudioAt > KEEPALIVE_MS) {
          try {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
          } catch {}
        }
      }, KEEPALIVE_MS);
      this.keepalive.unref?.();
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== "Results") return;
      const segment = segmentFromResults(msg);
      if (!segment) return;
      // Echo suppression sits HERE, at the single ingestion point: a
      // suppressed segment (the app's own spoken ack coming back through the
      // mic) never reaches the stored transcript, the live view, or the wake
      // gate — asserting on the transcript is the M5b acceptance. The guard
      // is biased toward letting speech through (3-token floor, 0.8
      // containment); a missed suppression costs one deletable card, while
      // over-suppression eats the operator's real words.
      if (this.lane.suppressFilter?.(this.sessionId, segment)) return;
      if (segment.final) {
        this.segments.push(segment);
        counters.bump("transcribe_segments_final");
      } else {
        counters.bump("transcribe_segments_interim");
      }
      for (const listener of this.listeners) {
        try {
          listener(segment);
        } catch {}
      }
      this.lane.onSegment?.(this.sessionId, segment);
    });
    ws.on("close", () => {
      this.open = false;
      if (this.keepalive) clearInterval(this.keepalive);
      if (!this.ended) {
        // Unexpected drop mid-session: one delayed reconnect per drop. The
        // gap is lost words, counted, never a crashed session.
        counters.bump("transcribe_disconnects");
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
        this.reconnectTimer.unref?.();
      }
    });
    ws.on("error", (err) => {
      counters.bump("transcribe_errors");
      log.error(`[capture-service] deepgram socket error: ${err?.message ?? err}`);
    });
  }

  feed(rawBytes) {
    // CBR-padded code-3 packets stall Deepgram's live decoder (the
    // 2026-08-15 "captures almost nothing" incident); unwrap them to code-0
    // here, at the one point every packet passes. The media log keeps the
    // original bytes — this rewrite exists only on the STT wire.
    const bytes = normalizeOpusPacket(rawBytes);
    if (bytes !== rawBytes) this.lane.counters.bump("opus_packets_normalized");
    this.lastAudioAt = Date.now();
    if (this.open) {
      try {
        this.ws.send(bytes);
        return;
      } catch {
        this.open = false;
      }
    }
    this.queue.push(bytes);
    if (this.queue.length > FEED_QUEUE_MAX) {
      this.queue.shift();
      this.lane.counters.bump("transcribe_feed_dropped");
    }
  }

  async end() {
    this.ended = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.ws && this.open) {
      // CloseStream flushes pending finals; wait briefly for them to arrive.
      const closed = new Promise((resolve) => {
        this.ws.once("close", resolve);
        setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS).unref?.();
      });
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      await closed;
      try {
        this.ws.close();
      } catch {}
    } else if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    for (const listener of this.listeners) {
      try {
        listener({ done: true });
      } catch {}
    }
    this.listeners.clear();
    return this.segments.slice().sort((a, b) => a.start - b.start);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class TranscriptionLane {
  constructor({ cfg, counters, log = console, wsFactory = null, onSegment = null, suppressFilter = null }) {
    this.cfg = cfg;
    this.counters = counters;
    this.log = log;
    this.wsFactory = wsFactory ?? cfg.wsFactory ?? ((url, opts) => new WebSocket(url, opts));
    this.onSegment = onSegment;
    // (sessionId, segment) => boolean; true drops the segment before storage,
    // the live view and the wake feed (echo suppression, §2.5 defence 3).
    this.suppressFilter = suppressFilter;
    this.sessions = new Map();
  }

  // True when the lane can actually transcribe; callers log the skip reason.
  available() {
    if (!this.cfg.transcribeEnabled) return { ok: false, reason: "transcribe disabled" };
    if (!this.cfg.secrets.deepgramApiKey) return { ok: false, reason: "DEEPGRAM_API_KEY not sealed" };
    return { ok: true };
  }

  openSession(sessionId) {
    const availability = this.available();
    if (!availability.ok) {
      this.counters.bump("transcribe_skipped");
      this.log.log(`[capture-service] transcription skipped for session: ${availability.reason}`);
      return false;
    }
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new SessionTranscription(this, sessionId));
      this.counters.bump("transcribe_sessions");
    }
    return true;
  }

  feed(sessionId, bytes) {
    this.sessions.get(sessionId)?.feed(bytes);
  }

  liveSegments(sessionId) {
    return this.sessions.get(sessionId)?.segments.slice() ?? null;
  }

  subscribe(sessionId, listener) {
    const session = this.sessions.get(sessionId);
    return session ? session.subscribe(listener) : null;
  }

  async end(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.sessions.delete(sessionId);
    return session.end();
  }

  close() {
    for (const [id, session] of this.sessions) {
      session.ended = true;
      try {
        session.ws?.close();
      } catch {}
      this.sessions.delete(id);
    }
  }
}
