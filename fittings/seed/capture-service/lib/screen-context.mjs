// "Zeca, responde-lhe que é melhor amanhã."
//
// The frames have always arrived and always been stored - the broadcast
// extension ships 1.5fps JPEG stills, ingress accepts them, media-log writes
// them to media/<sessionId>/frames/<seq>.jpg. Nothing ever read them back. That
// was deliberate ("no interpretation of screen content in this version") and
// this is the change that reverses it.
//
// THE HARD PART IS THAT THE COMMAND AND THE FRAMES ARE DIFFERENT SESSIONS.
// The wearer keeps the pendant on - it carries the mic, the wake word, the
// haptics and the voice - and starts the broadcast separately from Control
// Centre. So the spoken command arrives on a `pendant` session and the pixels
// arrive on a live `screen_audio` one, with no id joining them. The join is
// time plus liveness.
//
// The anchor is the WAKE HIT, not dispatch. wake_max_capture_ms runs to 45s in
// the live composition, so by the time a command dispatches the user may have
// been looking at that screen the better part of a minute ago. ios-thing
// snapshotted at command time for exactly this reason.
//
// Socket state is deliberately NOT checked: a session legitimately survives a
// socket drop, and a dropped socket shows up as staleness anyway - which is the
// honest signal rather than a second one that can disagree.

const DEFAULT_MAX_AGE_MS = 30_000; // ios-thing's FRAME_MAX_AGE_MS

export class ScreenContextIndex {
  constructor({ ingress, cfg = {}, counters = null, now = () => Date.now() }) {
    this.ingress = ingress;
    this.cfg = cfg;
    this.counters = counters;
    this.now = now;
  }

  maxAgeMs() {
    return this.cfg.screenContextMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  // -> { sessionId, seq, file, ageMs } | null
  //
  // `atMs` is the moment the user SPOKE. A miss is never silent: the caller
  // turns it into something the wearer hears, because a command that quietly
  // loses its screen and acts on a guess is the dangerous failure here.
  latest({ atMs = null } = {}) {
    if (!this.cfg.screenContextEnabled) return null;
    const anchor = typeof atMs === "number" ? atMs : this.now();
    let best = null;
    for (const session of this.ingress?.sessions?.values?.() ?? []) {
      if (session?.record?.mode !== "screen_audio") continue;
      const frame = session.media?.latestFrame?.();
      if (!frame) continue;
      if (!best || frame.atMs > best.frame.atMs) best = { sessionId: session.record.id, frame };
    }
    if (!best) {
      this.counters?.bump?.("screen_context_absent");
      return null;
    }
    const ageMs = Math.max(0, anchor - best.frame.atMs);
    if (ageMs > this.maxAgeMs()) {
      // Reported as MISSING, but with the real age, so the wearer can be told
      // "I haven't seen your screen for two minutes" rather than a flat no.
      this.counters?.bump?.("screen_context_stale");
      return { stale: true, sessionId: best.sessionId, seq: best.frame.seq, file: best.frame.file, ageMs };
    }
    this.counters?.bump?.("screen_context_hits");
    this.counters?.observe?.("screen_context_age_ms", ageMs);
    return { stale: false, sessionId: best.sessionId, seq: best.frame.seq, file: best.frame.file, ageMs };
  }
}
