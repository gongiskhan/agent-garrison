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
import { applyAliases } from "./pronunciation-aliases.mjs";

const KEEPALIVE_MS = 5000;
const CLOSE_FLUSH_TIMEOUT_MS = 3000;
const RECONNECT_DELAY_MS = 1000;
const FEED_QUEUE_MAX = 1024; // ~20s of 20ms packets buffered across a reconnect

// `language` overrides the deployment pin for ONE session: the screen
// broadcast speaks the language of a coding session (see screenSttLanguage in
// config.mjs), the pendant keeps the household pin.
export function deepgramUrl(cfg, { language = null } = {}) {
  const params = new URLSearchParams({
    model: cfg.sttModel,
    language: String(language ?? "").trim() || cfg.sttLanguage,
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
  constructor(lane, sessionId, { language = null } = {}) {
    this.lane = lane;
    this.sessionId = sessionId;
    this.language = language;
    this.segments = []; // finals only
    this.listeners = new Set(); // live-view subscribers
    this.queue = []; // Buffers awaiting an open socket
    this.ws = null;
    this.open = false;
    this.ended = false;
    this.lastAudioAt = 0;
    this.lastResultAt = 0;
    this.lastInboundAt = 0;
    this.muteWatchdog = null;
    // One log line per message TYPE per session, not per frame.
    this.loggedMessageTypes = new Set();
    this.keepalive = null;
    this.reconnectTimer = null;
    this.connect();
  }

  connect() {
    const { cfg, counters, log } = this.lane;
    let ws;
    try {
      ws = this.lane.wsFactory(deepgramUrl(cfg, { language: this.language }), {
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
      this.lastInboundAt = Date.now();
      this.armMuteWatchdog();
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
      // ANY inbound frame is proof the far end is still processing this
      // stream - that is what the mute watchdog measures, not transcripts.
      this.lastInboundAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Everything that is NOT a transcript used to be dropped on this line,
      // silently. That includes Deepgram's own Error and Warning frames - so a
      // stream Deepgram was actively refusing looked, from here, exactly like a
      // stream nobody was talking into: audio_frames_in climbing, segment
      // counters frozen, no log, no counter, nothing to grep. That is precisely
      // the shape of the 2026-08-27 "it is not listening" report, and it cost
      // hours that a single log line would have closed.
      //
      // Metadata is routine (one per connection) and stays quiet at info level;
      // anything else is surfaced once per type per connection - enough to
      // diagnose, never enough to flood a long session. Content is NOT logged
      // (I5): a transcript never reaches here, and these frames carry status,
      // not speech.
      if (msg.type !== "Results") {
        const type = String(msg.type ?? "unknown");
        counters.bump(`transcribe_dg_${type.toLowerCase()}`);
        if (type !== "Metadata" && !this.loggedMessageTypes.has(type)) {
          this.loggedMessageTypes.add(type);
          const detail = [msg.description, msg.message, msg.reason, msg.err_msg]
            .filter((v) => typeof v === "string" && v.trim())
            .join(" | ")
            .slice(0, 300);
          log.error(
            `[capture-service] deepgram sent ${type}${detail ? `: ${detail}` : ""} (session ${this.sessionId})`
          );
        }
        return;
      }
      this.lastResultAt = Date.now();
      const segment = segmentFromResults(msg);
      if (!segment) return;
      // Fix known mishearings AFTER the bias, before storage/dispatch (I5:
      // this touches only in-flight segment text, never a log or counter).
      if (cfg.sttAliases) segment.text = applyAliases(segment.text, cfg.sttAliases);
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
    ws.on("close", (code, reason) => {
      this.open = false;
      if (this.keepalive) clearInterval(this.keepalive);
      if (this.muteWatchdog) clearInterval(this.muteWatchdog);
      if (!this.ended) {
        // The code and reason are the only account Deepgram gives of WHY it
        // hung up; without them a drop is indistinguishable from a network
        // blip and the reconnect loop hides the cause forever.
        log.error(
          `[capture-service] deepgram closed mid-session: ${code}` +
            `${reason?.length ? ` ${String(reason).slice(0, 200)}` : ""} (session ${this.sessionId})`
        );
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

  // The zombie-socket watchdog (2026-08-27).
  //
  // A live pendant session went deaf and STAYED deaf: audio streaming out at
  // the full 50 packets/s into an ESTABLISHED socket with a draining send
  // queue, and not one frame coming back - no transcript, no error, no close.
  // Deepgram had stopped processing the stream without telling anyone, and
  // nothing here could notice, because every liveness signal we had was
  // outbound. Only restarting the process fixed it, and until someone noticed,
  // the wearer's device simply did not work.
  //
  // The measure is deliberately ANY inbound frame, not transcripts: Deepgram
  // legitimately sends nothing through a silent room, so "no words for N
  // seconds" is not evidence of anything. Paired with the KeepAlive above -
  // which we send whenever audio goes quiet - a far end that is alive and
  // attending to this stream does not stay mute for minutes on end.
  //
  // The asymmetry is the whole argument for a generous threshold plus a bias
  // toward acting: a false positive costs one reconnect and a ~1s gap, while a
  // miss costs every word until a human notices the device is dead.
  armMuteWatchdog() {
    if (this.muteWatchdog) clearInterval(this.muteWatchdog);
    const muteMs = this.lane.cfg.transcribeMuteTimeoutMs ?? 0;
    if (muteMs <= 0) return;
    this.muteWatchdog = setInterval(() => {
      if (this.ended || !this.open) return;
      const now = Date.now();
      // Only judge a stream we are actually feeding. An idle session that has
      // sent no audio has no right to expect an answer.
      if (now - this.lastAudioAt > muteMs) return;
      if (now - this.lastInboundAt < muteMs) return;
      this.lane.counters.bump("transcribe_mute_reconnects");
      this.lane.log.error(
        `[capture-service] deepgram went mute: fed audio for ${Math.round((now - this.lastInboundAt) / 1000)}s ` +
          `with nothing inbound - reconnecting (session ${this.sessionId})`
      );
      // terminate(), not close(): a wedged peer may never answer a close
      // handshake, and the 'close' handler is what schedules the reconnect.
      try {
        this.ws?.terminate?.() ?? this.ws?.close?.();
      } catch {}
      this.open = false;
    }, Math.max(1000, Math.floor(muteMs / 4)));
    this.muteWatchdog.unref?.();
  }

  async end() {
    this.ended = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.muteWatchdog) clearInterval(this.muteWatchdog);
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

  openSession(sessionId, { language = null } = {}) {
    const availability = this.available();
    if (!availability.ok) {
      this.counters.bump("transcribe_skipped");
      this.log.log(`[capture-service] transcription skipped for session: ${availability.reason}`);
      return false;
    }
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new SessionTranscription(this, sessionId, { language }));
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
