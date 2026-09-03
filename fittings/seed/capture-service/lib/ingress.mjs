// Websocket session ingress (spec §4).
//
// One websocket per session, Bearer CAPTURE_TOKEN on the upgrade. Control
// messages are JSON text frames; media is binary with a fixed 17-byte
// little-endian header:
//
//   [u8 kind][u32 seq][f64 ts_ms][u32 len][payload]     kind 0 = Opus packet
//                                                       kind 1 = JPEG frame
//
// The server acks {type:"ack", stream, seq} with the highest CONTIGUOUS
// persisted seq per stream — the client resumes from the last acked seq after
// a drop (invariant I7; the media log only ever appends next-expected, so a
// double replay is byte-identical). The ack carries a stream tag because two
// interleaved streams share one socket and a bare number is ambiguous.
//
// Sessions survive socket drops: a session_start naming a known LIVE session
// resumes it and the server answers with both high-water marks. A session that
// already ENDED refuses to reopen (dedupe by session id). A second socket for
// a live session supersedes the first (a phone reconnecting after a network
// blip often beats its own dying TCP connection).
//
// Log privacy (invariant I5): nothing here logs payload bytes or transcript
// text — only ids, seqs, counts and reasons.
//
// Text sessions (D24): a second, socket-less kind of session for transcript
// segments another service already produced (omi-channel's realtime feed,
// forwarded over POST /capture/ingest/text). They live in the same map so the
// wake buses and /health see one population, but they carry no media log, no
// transcript file and no capture_event - the forwarding channel keeps its own
// memory path, so nothing is ingested twice. They end on idle silence alone.

import crypto from "node:crypto";
import path from "node:path";
import { WebSocketServer } from "ws";
import { atomicWriteJSON, readJSON } from "./store.mjs";
import { SessionMedia } from "./media-log.mjs";

export const FRAME_HEADER = 17; // u8 kind + u32 seq + f64 ts + u32 len
const KIND_AUDIO = 0;
const KIND_VIDEO = 1;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024; // one JPEG still fits comfortably

const SESSION_ID_RE = /^[A-Za-z0-9_-]{10,40}$/;
// "pendant" (ADR D5): the Companion relaying the BLE pendant's Opus stream.
// Additive - the malformed "always_on" refusal and both mic modes are
// untouched. Pendant sessions are additionally gated on cfg.pendantEnabled
// and are the ONLY sessions capture_policy applies to (ADR D6).
const MODES = new Set(["audio", "screen_audio", "pendant"]);
// Sources allowed to open a text session (D24). The source doubles as the
// session mode, so a text session can never be mistaken for a microphone.
export const TEXT_SOURCES = new Set(["omi"]);
// The forwarding service's own session id, kept verbatim inside the key
// "<source>:<id>". Wider than SESSION_ID_RE on purpose (Omi ids are opaque),
// still bounded and path-safe; the colon keeps the key out of the WS id space.
export const TEXT_SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const CONSENT = new Set(["shown", "suppressed"]);
const END_REASONS = new Set(["user", "error", "timeout"]);
const PENDANT_CODECS = new Set(["opus", "opus_fs320"]);

// Timing-safe token compare via fixed-length digests (omi ingress pattern).
export function tokenMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = crypto.createHash("sha256").update(String(presented)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

export function bearerToken(req) {
  const header = req.headers?.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function parseMediaFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < FRAME_HEADER) return null;
  const kind = buf.readUInt8(0);
  const seq = buf.readUInt32LE(1);
  const ts = buf.readDoubleLE(5);
  const len = buf.readUInt32LE(13);
  if (kind !== KIND_AUDIO && kind !== KIND_VIDEO) return null;
  if (len !== buf.length - FRAME_HEADER || len > MAX_FRAME_BYTES) return null;
  return { kind, seq, ts, bytes: buf.subarray(FRAME_HEADER) };
}

export function encodeMediaFrame(kind, seq, ts, bytes) {
  const header = Buffer.alloc(FRAME_HEADER);
  header.writeUInt8(kind, 0);
  header.writeUInt32LE(seq >>> 0, 1);
  header.writeDoubleLE(Number(ts) || 0, 5);
  header.writeUInt32LE(bytes.length >>> 0, 13);
  return Buffer.concat([header, bytes]);
}

// The Conversations thread a recording was started from (plan G5). Same
// vocabulary as the thread store's safeThreadId: the digest is posted back to
// exactly this id, so anything the store would rewrite is refused up front.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function validateSessionStart(msg) {
  if (typeof msg.session_id !== "string" || !SESSION_ID_RE.test(msg.session_id)) {
    return "session_id must be 10-40 chars of [A-Za-z0-9_-]";
  }
  if (!MODES.has(msg.mode)) return 'mode must be "audio" or "screen_audio"';
  if (!CONSENT.has(msg.consent)) return 'consent must be "shown" or "suppressed"';
  if (msg.started_at !== undefined && Number.isNaN(Date.parse(msg.started_at))) {
    return "started_at must be an ISO timestamp when present";
  }
  if (msg.conversation_id !== undefined && msg.conversation_id !== null &&
      (typeof msg.conversation_id !== "string" || !CONVERSATION_ID_RE.test(msg.conversation_id))) {
    return "conversation_id must be 1-80 chars of [A-Za-z0-9_-] when present";
  }
  return null;
}

export class CaptureIngress {
  constructor({ cfg, store, counters, log = console, now = () => Date.now(), onSessionEnd = null, transcriber = null }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.log = log;
    this.now = now;
    // M4 seam: called with the finalized session record when a session ends.
    this.onSessionEnd = onSessionEnd;
    // M2: the Deepgram lane; null when the flag or key is absent.
    this.transcriber = transcriber;
    // session_id -> {record, media, socket, idleTimer}; a text session (D24)
    // has media null, socket null and text true.
    this.sessions = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + FRAME_HEADER });
  }

  sessionFile(id) {
    return path.join(this.store.dirs.sessions, `${id}.json`);
  }

  readSessionRecord(id) {
    return readJSON(this.sessionFile(id));
  }

  writeSessionRecord(record) {
    atomicWriteJSON(this.sessionFile(record.id), record);
  }

  // Registered on the http server's `upgrade` event. Auth failures answer a
  // plain HTTP status on the raw socket — there is no websocket yet.
  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/capture/stream") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!this.cfg.enabled) {
      this.counters.bump("rejected_disabled");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!this.cfg.secrets.captureToken) {
      this.counters.bump("rejected_no_secret");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!tokenMatches(bearerToken(req), this.cfg.secrets.captureToken)) {
      this.counters.bump("rejected_auth");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
  }

  handleConnection(ws) {
    let session = null; // set by session_start

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          if (!session) {
            send({ type: "error", error: "media before session_start" });
            ws.close(1008, "no session");
            return;
          }
          this.handleMediaFrame(session, data, send);
          return;
        }
        if (data.length > MAX_TEXT_BYTES) {
          ws.close(1009, "control frame too large");
          return;
        }
        let msg;
        try {
          msg = JSON.parse(data.toString("utf8"));
        } catch {
          this.counters.bump("sessions_malformed");
          send({ type: "error", error: "invalid JSON" });
          ws.close(1008, "invalid JSON");
          return;
        }
        if (msg?.type === "session_start") {
          session = this.handleSessionStart(ws, msg, send);
          return;
        }
        if (msg?.type === "session_end") {
          if (!session) {
            ws.close(1008, "no session");
            return;
          }
          const reason = END_REASONS.has(msg.reason) ? msg.reason : "user";
          // Finalize awaits the transcript flush; the session_ended reply
          // means the record (and any transcript) is on disk.
          void this.finalizeSession(session.record.id, reason).then(() => {
            send({ type: "session_ended", reason });
            ws.close(1000, "ended");
          });
          return;
        }
        if (msg?.type === "feedback_ack") {
          // {event_id, at?} — the Companion's receipt that a feedback event
          // reached the device/phone sink; closes the latency measurement.
          if (!session) {
            ws.close(1008, "no session");
            return;
          }
          if (this.onFeedbackAck) this.onFeedbackAck(session.record.id, msg);
          else this.counters.bump("feedback_acks_ignored");
          return;
        }
        if (msg?.type === "spoken") {
          // {spoken: <ack id>, ok, reason?} — the app's speech receipt. A
          // sink that silently drops is indistinguishable from one that is
          // off, so the server keeps the receipt ledger (set by the server
          // after construction; counted if nothing is listening).
          if (this.onSpokenReceipt) this.onSpokenReceipt(msg);
          else this.counters.bump("spoken_receipts_ignored");
          return;
        }
        send({ type: "error", error: "unknown message type" });
      } catch (err) {
        // A webhook-grade surface must never crash on one bad frame.
        this.log.error(`[capture-service] ingress error: ${err?.message ?? err}`);
        try {
          ws.close(1011, "internal error");
        } catch {}
      }
    });

    ws.on("close", () => {
      if (session) {
        const live = this.sessions.get(session.record.id);
        if (live && live.socket === ws) live.socket = null;
        // The session itself stays open for resume until session_end or the
        // idle timeout — a socket drop is not a session end (invariant I7).
      }
    });
  }

  handleSessionStart(ws, msg, send) {
    const invalid = validateSessionStart(msg);
    if (invalid) {
      this.counters.bump("sessions_malformed");
      send({ type: "error", error: invalid });
      ws.close(1008, "malformed session_start");
      return null;
    }
    if (msg.mode === "pendant" && !this.cfg.pendantEnabled) {
      // The pendant path's own kill switch (I7): independent of `enabled`
      // (which gated the upgrade) and of every omi-channel flag.
      this.counters.bump("rejected_pendant_disabled");
      send({ type: "error", error: "pendant capture disabled" });
      ws.close(1008, "pendant disabled");
      return null;
    }
    const id = msg.session_id;

    const existingLive = this.sessions.get(id);
    if (existingLive) {
      // Supersede: the reconnecting phone often beats its own dying TCP.
      if (existingLive.socket && existingLive.socket !== ws) {
        try {
          existingLive.socket.close(4000, "superseded");
        } catch {}
      }
      existingLive.socket = ws;
      this.armIdleTimer(existingLive);
      this.counters.bump("sessions_resumed");
      const hw = existingLive.media.highWater();
      send({ type: "session_resumed", session_id: id, audio_seq: hw.audio, video_seq: hw.video });
      return existingLive;
    }

    const stored = this.readSessionRecord(id);
    if (stored && stored.status === "ended") {
      this.counters.bump("sessions_rejected_ended");
      send({ type: "error", error: "session already ended" });
      ws.close(1008, "session already ended");
      return null;
    }

    const record = stored ?? {
      id,
      source: msg.mode === "pendant" ? "pendant" : "companion-ios",
      mode: msg.mode,
      device_name: String(msg.device_name ?? "iPhone").trim().slice(0, 64) || "iPhone",
      // Consent context travels in provenance (invariant I6).
      consent: msg.consent,
      started_at: msg.started_at ?? null,
      // The conversation the record button lived in; the digest posts there.
      ...(typeof msg.conversation_id === "string" ? { conversation_id: msg.conversation_id } : {}),
      // Informational (pendant sessions): which Opus framing the device ships.
      ...(msg.mode === "pendant" && PENDANT_CODECS.has(msg.codec) ? { codec: msg.codec } : {}),
      status: "live",
      audio_seq: 0,
      video_seq: 0,
      audio_bytes: 0,
      ended: null
    };
    // capture_policy enforcement point 1 of 2 (ADR D6): a wake_only pendant
    // session persists no media - the ordered-stream discipline runs against
    // an in-memory high water instead of the media log.
    const transient = record.mode === "pendant" && this.cfg.capturePolicy !== "ambient";
    if (!stored && !transient) this.writeSessionRecord(record);
    if (!stored && transient) this.counters.bump("pendant_sessions_unpersisted");

    // Pendant + broadcast means ONE spoken sentence reaches TWO microphones in
    // the same room: the pendant's and the broadcast extension's. Both streams
    // transcribe, both hit a wake bus, and because those are separate WakeBus
    // instances no instance-local dedupe can see both - so one "Zeca, cria uma
    // tarefa" made two cards, and would have made two WhatsApp messages.
    //
    // With the pendant carrying mic, wake word, haptics and voice, the
    // broadcast is a source of PIXELS. Its audio still spools and stores; it
    // just does not open a second transcription. A context-only broadcast
    // therefore produces no transcript, and its end-of-session capture_event is
    // thin - correct, and honest.
    //
    // The dedupe is decided per session, not per install: a broadcast that
    // starts while a pendant session is live stays pixels-only; one started
    // with no pendant around is the phone's ONLY microphone, and silencing it
    // is what made "Zeca" from the REC button land on nothing. The flag is the
    // hard override for a wearer who wants the broadcast mute regardless.
    const pendantLive = [...this.sessions.values()].some(
      (live) => live.record.mode === "pendant" && !live.record.ended
    );
    const wantsTranscription =
      record.mode !== "screen_audio" || (this.cfg.screenAudioTranscribe !== false && !pendantLive);
    if (!wantsTranscription) this.counters.bump("screen_audio_transcription_skipped");
    const transcribing = this.transcriber && wantsTranscription ? this.transcriber.openSession(id) : false;
    const media = new SessionMedia(this.store.dirs.media, id, {
      counters: this.counters,
      transient,
      onAudioFrame: transcribing ? (seq, ts, bytes) => this.transcriber.feed(id, bytes) : null
    });
    const session = { record, media, socket: ws, idleTimer: null };
    this.sessions.set(id, session);
    this.armIdleTimer(session);

    if (stored) {
      // Process restart mid-session: the record was live on disk but memory
      // was empty. Resume from the scanned media high-water.
      this.counters.bump("sessions_resumed");
      const hw = media.highWater();
      send({ type: "session_resumed", session_id: id, audio_seq: hw.audio, video_seq: hw.video });
    } else {
      this.counters.bump("sessions_started");
      send({ type: "session_started", session_id: id });
    }
    return session;
  }

  handleMediaFrame(session, data, send) {
    const frame = parseMediaFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (!frame) {
      this.counters.bump("media_frames_malformed");
      send({ type: "error", error: "malformed media frame" });
      return;
    }
    this.armIdleTimer(session);
    if (frame.kind === KIND_AUDIO) {
      this.counters.bump("audio_frames_in");
      const acked = session.media.acceptAudio(frame.seq, frame.ts, frame.bytes);
      send({ type: "ack", stream: "audio", seq: acked });
    } else {
      this.counters.bump("video_frames_in");
      const acked = session.media.acceptVideo(frame.seq, frame.ts, frame.bytes);
      send({ type: "ack", stream: "video", seq: acked });
    }
  }

  armIdleTimer(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.counters.bump("sessions_timeout");
      void this.finalizeSession(session.record.id, "timeout").then(() => {
        try {
          session.socket?.close(1000, "session timeout");
        } catch {}
      });
    }, this.cfg.sessionIdleTimeoutMs);
    session.idleTimer.unref?.();
  }

  // ---- Text sessions (D24) --------------------------------------------------

  static textSessionKey(source, sessionId) {
    return `${source}:${sessionId}`;
  }

  // Open, or extend, the socket-less text session for one forwarded stream.
  // Nothing touches disk: the record lives in memory until the idle timer
  // closes it. Returns { session, created }.
  openTextSession({ source, sessionId }) {
    if (!TEXT_SOURCES.has(source)) throw new Error(`unknown text source: ${source}`);
    const id = CaptureIngress.textSessionKey(source, sessionId);
    const existing = this.sessions.get(id);
    if (existing) {
      this.armTextIdleTimer(existing);
      return { session: existing, created: false };
    }
    const record = {
      id,
      source,
      // The mode IS the source: never "audio"/"pendant", so the speakable-session
      // pick and the screen-context index skip it without knowing about it.
      mode: source,
      external_session_id: sessionId,
      // No device, no consent screen of ours: the forwarding app owns both.
      device_name: null,
      consent: null,
      started_at: new Date(this.now()).toISOString(),
      status: "live",
      text: true,
      segments: 0,
      ended: null
    };
    const session = { record, media: null, socket: null, idleTimer: null, text: true };
    this.sessions.set(id, session);
    this.armTextIdleTimer(session);
    this.counters.bump("text_sessions_opened");
    return { session, created: true };
  }

  // Segments arrived: count them on the record and push the idle close out.
  noteTextSegments(session, count) {
    session.record.segments += count;
    this.armTextIdleTimer(session);
  }

  armTextIdleTimer(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.finalizeTextSession(session.record.id, "timeout");
    }, this.cfg.textSessionIdleMs);
    session.idleTimer.unref?.();
  }

  // The text session's ONLY exit. Deliberately not finalizeSession: no media
  // high-water, no transcript flush, no session record on disk, and above all
  // no onSessionEnd - a capture_event here would ingest the forwarding
  // channel's conversation a second time.
  finalizeTextSession(id, reason) {
    const session = this.sessions.get(id);
    if (!session || !session.text) return false;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(id);
    session.record.status = "ended";
    session.record.ended = { reason };
    this.counters.bump("text_sessions_closed");
    return true;
  }

  async finalizeSession(id, reason) {
    const session = this.sessions.get(id);
    if (!session) return;
    // A text session takes its own exit whoever asks (see above).
    if (session.text) {
      this.finalizeTextSession(id, reason);
      return;
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(id);

    // Flush the transcription lane first so the record can reference the
    // stored transcript. A lane failure costs the transcript, never the
    // session record (counted, logged without content — I5).
    // capture_policy enforcement point 2 of 2 (ADR D6): under wake_only a
    // pendant session's finalized segments are dropped here, in memory -
    // never written, never logged with content. Counters only.
    const transient = Boolean(session.media.transient);
    let transcript = null;
    if (this.transcriber) {
      try {
        const segments = await this.transcriber.end(id);
        if (segments && segments.length > 0) {
          if (transient) {
            this.counters.bump("transcripts_dropped_policy");
            this.counters.observe("transcript_segments_dropped_policy", segments.length);
          } else {
            transcript = {
              session_id: id,
              segments,
              words: segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
            };
            atomicWriteJSON(path.join(this.store.dirs.transcripts, `${id}.json`), transcript);
            this.counters.bump("transcripts_stored");
          }
        }
      } catch (err) {
        this.counters.bump("transcribe_finalize_failed");
        this.log.error(`[capture-service] transcript finalize failed: ${err?.message ?? err}`);
      }
    }

    const hw = session.media.highWater();
    const record = {
      ...session.record,
      status: "ended",
      audio_seq: hw.audio,
      video_seq: hw.video,
      audio_bytes: session.media.audioBytes(),
      ...(transcript
        ? { transcript_ref: `transcripts/${id}.json`, transcript_words: transcript.words }
        : {}),
      ended: { reason }
    };
    // A wake_only pendant session leaves no session record either: the only
    // persistence from such a session is the wake path itself.
    if (!transient) this.writeSessionRecord(record);
    this.counters.bump("sessions_ended");
    try {
      this.onSessionEnd?.(record);
    } catch (err) {
      // Losing the M4 emission must not lose the session record.
      this.log.error(`[capture-service] onSessionEnd failed: ${err?.message ?? err}`);
    }
  }

  // Graceful shutdown: keep live sessions resumable (records stay "live" on
  // disk; media high-water is recovered by scan on the next boot).
  close() {
    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      try {
        session.socket?.close(1001, "server shutting down");
      } catch {}
    }
    this.sessions.clear();
    this.wss.close();
  }
}
