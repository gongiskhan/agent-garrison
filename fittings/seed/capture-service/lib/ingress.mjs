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
const MODES = new Set(["audio", "screen_audio"]);
const CONSENT = new Set(["shown", "suppressed"]);
const END_REASONS = new Set(["user", "error", "timeout"]);

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

function validateSessionStart(msg) {
  if (typeof msg.session_id !== "string" || !SESSION_ID_RE.test(msg.session_id)) {
    return "session_id must be 10-40 chars of [A-Za-z0-9_-]";
  }
  if (!MODES.has(msg.mode)) return 'mode must be "audio" or "screen_audio"';
  if (!CONSENT.has(msg.consent)) return 'consent must be "shown" or "suppressed"';
  if (msg.started_at !== undefined && Number.isNaN(Date.parse(msg.started_at))) {
    return "started_at must be an ISO timestamp when present";
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
    this.sessions = new Map(); // session_id -> {record, media, socket, idleTimer}
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
      source: "companion-ios",
      mode: msg.mode,
      device_name: String(msg.device_name ?? "iPhone").trim().slice(0, 64) || "iPhone",
      // Consent context travels in provenance (invariant I6).
      consent: msg.consent,
      started_at: msg.started_at ?? null,
      status: "live",
      audio_seq: 0,
      video_seq: 0,
      audio_bytes: 0,
      ended: null
    };
    if (!stored) this.writeSessionRecord(record);

    const transcribing = this.transcriber ? this.transcriber.openSession(id) : false;
    const media = new SessionMedia(this.store.dirs.media, id, {
      counters: this.counters,
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

  async finalizeSession(id, reason) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(id);

    // Flush the transcription lane first so the record can reference the
    // stored transcript. A lane failure costs the transcript, never the
    // session record (counted, logged without content — I5).
    let transcript = null;
    if (this.transcriber) {
      try {
        const segments = await this.transcriber.end(id);
        if (segments && segments.length > 0) {
          transcript = {
            session_id: id,
            segments,
            words: segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
          };
          atomicWriteJSON(path.join(this.store.dirs.transcripts, `${id}.json`), transcript);
          this.counters.bump("transcripts_stored");
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
    this.writeSessionRecord(record);
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
