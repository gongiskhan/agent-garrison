// Per-session media storage (invariant I7: idempotent, resumable).
//
// Audio is an append-only framed log — one file per session, not one file per
// packet (a 1 h session at 20 ms Opus packets would be ~180k inodes):
//
//   media/<sessionId>/audio.log    [u32 seq][f64 ts][u32 len][bytes] …  (LE)
//
// Only the NEXT-EXPECTED seq is ever appended, so replaying any frame set
// twice yields a byte-identical log. Duplicates (seq <= high-water) are
// dropped-and-acked; frames ahead of the contiguous edge wait in a bounded
// in-memory reorder buffer and are drained when the gap fills. The high-water
// mark is recovered by scanning the log on open — the log itself is the
// authority, never a sidecar that could drift from it.
//
// Video (screen_audio mode) is JPEG stills at the extension's native ~1.5 fps,
// one file per seq — media/<sessionId>/frames/<seq>.jpg — where the same
// next-expected/reorder discipline applies. The stored frames ARE the spec's
// "keyframes extracted".

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const AUDIO_RECORD_HEADER = 16; // u32 seq + f64 ts + u32 len
export const REORDER_WINDOW = 256; // frames held beyond the contiguous edge

function encodeRecord(seq, ts, bytes) {
  const header = Buffer.alloc(AUDIO_RECORD_HEADER);
  header.writeUInt32LE(seq >>> 0, 0);
  header.writeDoubleLE(Number(ts) || 0, 4);
  header.writeUInt32LE(bytes.length >>> 0, 12);
  return Buffer.concat([header, bytes]);
}

// Scan the framed log and return the last contiguous seq recorded (0 = none).
// A truncated tail (crash mid-append) is ignored — the next append rewrites
// nothing and the partial record is simply dead bytes the reader skips by
// length-prefix walking until it runs off the end.
export function scanAudioLog(file) {
  if (!existsSync(file)) return { lastSeq: 0, records: 0 };
  const buf = readFileSync(file);
  let offset = 0;
  let lastSeq = 0;
  let records = 0;
  while (offset + AUDIO_RECORD_HEADER <= buf.length) {
    const seq = buf.readUInt32LE(offset);
    const len = buf.readUInt32LE(offset + 12);
    if (offset + AUDIO_RECORD_HEADER + len > buf.length) break; // truncated tail
    lastSeq = seq;
    records += 1;
    offset += AUDIO_RECORD_HEADER + len;
  }
  return { lastSeq, records };
}

// Iterate stored audio records (used by the M2 transcription lane and the
// replay client's effect-following).
export function* readAudioLog(file) {
  if (!existsSync(file)) return;
  const buf = readFileSync(file);
  let offset = 0;
  while (offset + AUDIO_RECORD_HEADER <= buf.length) {
    const seq = buf.readUInt32LE(offset);
    const ts = buf.readDoubleLE(offset + 4);
    const len = buf.readUInt32LE(offset + 12);
    if (offset + AUDIO_RECORD_HEADER + len > buf.length) return;
    yield { seq, ts, bytes: buf.subarray(offset + AUDIO_RECORD_HEADER, offset + AUDIO_RECORD_HEADER + len) };
    offset += AUDIO_RECORD_HEADER + len;
  }
}

// One ordered stream with the next-expected/reorder/dedupe discipline.
// `persist(seq, ts, bytes)` is called exactly once per accepted frame, in seq
// order. `accept()` returns the new contiguous high-water (the value to ack).
class OrderedStream {
  constructor({ lastSeq = 0, persist, counters = null, dedupeKey = "frames_deduped", dropKey = "frames_dropped_ahead" }) {
    this.lastSeq = lastSeq;
    this.persist = persist;
    this.counters = counters;
    this.dedupeKey = dedupeKey;
    this.dropKey = dropKey;
    this.pending = new Map(); // seq -> {ts, bytes}
  }

  accept(seq, ts, bytes) {
    if (!Number.isInteger(seq) || seq <= 0) return this.lastSeq;
    if (seq <= this.lastSeq || this.pending.has(seq)) {
      this.counters?.bump(this.dedupeKey);
      return this.lastSeq; // duplicate: ack the edge so a resumed client advances
    }
    if (seq > this.lastSeq + REORDER_WINDOW) {
      // Too far ahead to buffer. NOT acked: the client's resume-from-last-ack
      // resends it once the gap is filled.
      this.counters?.bump(this.dropKey);
      return this.lastSeq;
    }
    this.pending.set(seq, { ts, bytes });
    while (this.pending.has(this.lastSeq + 1)) {
      const next = this.lastSeq + 1;
      const frame = this.pending.get(next);
      this.pending.delete(next);
      this.persist(next, frame.ts, frame.bytes);
      this.lastSeq = next;
    }
    return this.lastSeq;
  }
}

export class SessionMedia {
  // `transient: true` (capture_policy wake_only on a pendant session, ADR D6)
  // keeps the full ordered-stream discipline - seq acks, dedupe, reorder
  // window, exactly-once in-order delivery to the transcription lane - while
  // writing NOTHING to disk: no directory, no audio.log, no frames. The high
  // water lives in memory only; a process restart forgets it, which is the
  // documented trade-off (a resuming client re-sends spooled frames and they
  // re-transcribe transiently).
  constructor(root, sessionId, { counters = null, onAudioFrame = null, transient = false } = {}) {
    this.transient = Boolean(transient);
    this.transientAudioBytes = 0;
    this.dir = path.join(root, sessionId);
    this.framesDir = path.join(this.dir, "frames");
    if (!this.transient) mkdirSync(this.framesDir, { recursive: true });
    this.audioFile = path.join(this.dir, "audio.log");
    const { lastSeq } = this.transient ? { lastSeq: 0 } : scanAudioLog(this.audioFile);
    this.audio = new OrderedStream({
      lastSeq,
      counters,
      dedupeKey: "audio_frames_deduped",
      dropKey: "audio_frames_dropped_ahead",
      // The hook fires once per persisted frame, in seq order, after the
      // append — the transcription lane sees exactly the bytes the log holds.
      persist: (seq, ts, bytes) => {
        if (this.transient) this.transientAudioBytes += bytes.length;
        else appendFileSync(this.audioFile, encodeRecord(seq, ts, bytes));
        onAudioFrame?.(seq, ts, bytes);
      }
    });
    this.video = new OrderedStream({
      lastSeq: this.transient ? 0 : this.scanFrames(),
      counters,
      dedupeKey: "video_frames_deduped",
      dropKey: "video_frames_dropped_ahead",
      persist: (seq, ts, bytes) => {
        if (!this.transient) writeFileSync(path.join(this.framesDir, `${seq}.jpg`), bytes);
      }
    });
  }

  // Highest contiguous stored frame number (files are 1.jpg, 2.jpg, …).
  scanFrames() {
    const seqs = readdirSync(this.framesDir)
      .map((f) => /^(\d+)\.jpg$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    let last = 0;
    for (const s of seqs) {
      if (s === last + 1) last = s;
      else break;
    }
    return last;
  }

  acceptAudio(seq, ts, bytes) {
    return this.audio.accept(seq, ts, bytes);
  }

  acceptVideo(seq, ts, bytes) {
    return this.video.accept(seq, ts, bytes);
  }

  highWater() {
    return { audio: this.audio.lastSeq, video: this.video.lastSeq };
  }

  audioBytes() {
    if (this.transient) return this.transientAudioBytes;
    try {
      return statSync(this.audioFile).size;
    } catch {
      return 0;
    }
  }
}
