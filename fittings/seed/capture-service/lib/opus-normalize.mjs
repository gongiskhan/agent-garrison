// Normalize raw Opus packets before they reach Deepgram's LIVE decoder.
//
// Why this exists (2026-08-15): AVAudioConverter with
// AVAudioBitRateStrategy_Constant emits code-3 packets — [TOC|code=3]
// [frame-count byte][padding-length byte(s)][frame][zero padding] — to hold
// a constant 80 bytes per 20 ms. ffmpeg and Deepgram's PRERECORDED API
// decode these fine, but Deepgram's live streaming decoder stalls after
// ~100 of them: a real 6-minute session live-transcribed as 4 garbage
// fragments (NET-0000 on replay, metadata duration 2.02 s for 122 s of
// audio) while the identical bytes with padding stripped transcribed
// correctly at conf 0.99. The iOS encoder no longer emits CBR, but the
// service must not depend on every past or future client build being
// polite — so the feed path unwraps single-frame code-3 packets to the
// equivalent code-0 packet (byte-identical audio payload, no padding).
//
// Anything unexpected (multi-frame, malformed padding, tiny packets)
// passes through untouched: this is a defensive rewrite, never a gate.

export function normalizeOpusPacket(bytes) {
  if (!bytes || bytes.length < 2) return bytes;
  const toc = bytes[0];
  if ((toc & 0x03) !== 3) return bytes; // codes 0-2: already fine
  const fc = bytes[1];
  const count = fc & 0x3f;
  if (count !== 1) return bytes; // multi-frame: leave alone
  const padded = (fc & 0x40) !== 0;
  let offset = 2;
  let padTotal = 0;
  if (padded) {
    // RFC 6716 §3.2.5: padding length bytes; 255 adds 254 and chains.
    let p;
    do {
      if (offset >= bytes.length) return bytes; // malformed: pass through
      p = bytes[offset];
      offset += 1;
      padTotal += p === 255 ? 254 : p;
    } while (p === 255);
  }
  const frameEnd = bytes.length - padTotal;
  if (frameEnd < offset) return bytes; // malformed: pass through
  // Rebuild as code 0 (single frame, same config/stereo bits).
  const out = Buffer.allocUnsafe(1 + (frameEnd - offset));
  out[0] = toc & 0xfc;
  bytes.copy(out, 1, offset, frameEnd);
  return out;
}
