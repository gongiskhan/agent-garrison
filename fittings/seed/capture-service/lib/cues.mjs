// Spoken cues - the two words that tell the wearer they were heard.
//
// Before this, the phone spoke exactly once per command: when the card already
// existed, roughly 25 seconds after the wake word. The wearer said "Zeca" into
// silence, spoke a whole task into silence, and had no way to tell "heard you"
// from "did not hear you" until it was far too late to repeat themselves. That
// is the same ambiguity the wake haptic was added to solve, and the haptic only
// half-solved it: a buzz says something happened, not that the right thing did.
//
// Two cues, and only two:
//
//   wake_detected  "Sim?" / "Yes?"  - I am listening, start talking
//   window_closed  "Ok."  / "Okay." - I stopped listening, working on it
//
// Deliberately NOT cued:
//   segment_captured - fires repeatedly, mid-sentence. It would talk over the
//     wearer while they are still dictating.
//   task_created / task_failed - the ack lane already speaks these. A cue here
//     would say the same thing twice, seconds apart, in two different voices.
//   wake_lapsed - present but null, see below.
//
// Cues ride the FEEDBACK lane, never POST /ack. Acks are post-persistence
// outcomes by invariant (ack-sink.mjs) and carry burst control and an APNs
// fallthrough; a cue is neither an outcome nor something to push to a phone
// that is not listening right now.

import { detectLanguage, isLanguage } from "./lang.mjs";

// Two cues x two languages = four clips, ever. That is what makes prewarming
// and pinning trivial, and it is why this is a table and not a template.
export const CUE_TEXT = {
  wake_detected: { pt: "Sim?", en: "Yes?" },
  // Not "Ok." - a one-syllable TTS clip lands clipped and odd, and it says
  // nothing. The honest content of this moment is "I stopped listening and
  // started working", and the wait it opens is ~25 seconds, so the cue is a
  // handoff, not an acknowledgement syllable.
  window_closed: { pt: "Deixa comigo.", en: "On it." },
  // An interim wake hit that the final never confirms. The wearer already felt
  // the pulse, so there is an argument for saying "Desculpa." here - but a
  // retraction is only worth its own interruption if lapses are common, and
  // feedback_wake_unconfirmed on /health answers that empirically. Flipping
  // this null to a string is a one-line change when the number says so.
  wake_lapsed: null,
  segment_captured: null,
  task_created: null,
  task_failed: null
};

export class Cues {
  constructor({ cfg, voice = null, counters = null, log = console }) {
    this.cfg = cfg;
    this.voice = voice;
    this.counters = counters;
    this.log = log;
  }

  enabled() {
    return Boolean(this.cfg.cueEnabled);
  }

  textFor(name, lang) {
    const entry = CUE_TEXT[name];
    if (!entry) return null;
    return entry[isLanguage(lang) ? lang : "pt"] ?? null;
  }

  // -> { text, lang, audio_path? } | null. NEVER async, never throws: this runs
  // inside the feedback subscriber, on the path to the device haptic.
  //
  // A missing clip is not a failure. The text still travels and the phone
  // speaks it with its own synthesizer, exactly as SpeechSink already does for
  // an ack whose clip could not be fetched.
  speechFor(name, lang) {
    if (!this.enabled()) return null;
    const text = this.textFor(name, lang);
    if (!text) return null;
    const speak = { text, lang: isLanguage(lang) ? lang : "pt", priority: "cue" };
    try {
      const clip = this.voice?.cachedClipFor(text) ?? null;
      if (clip) {
        speak.audio_path = `/speak/${clip.id}.mp3`;
        this.counters?.bump?.("cue_clip_hits");
      } else {
        this.counters?.bump?.("cue_clip_misses");
        // Repair in the background so the NEXT one is warm. A no-op on a hit,
        // and it can never delay this call.
        void this.ensure(text);
      }
    } catch (err) {
      this.counters?.bump?.("cue_clip_errors");
      this.log?.error?.(`[capture-service] cue clip lookup failed: ${err?.message ?? err}`);
    }
    this.counters?.bump?.(`cue_${name}`);
    return speak;
  }

  // Render a cue line if it is not already on disk, and pin it so the
  // oldest-first prune cannot evict it behind ordinary card titles.
  async ensure(text) {
    if (!this.voice) return null;
    try {
      const clip = await this.voice.clipFor(text);
      if (clip?.id) this.voice.pin(clip.id);
      return clip;
    } catch {
      return null;
    }
  }

  // Called once at startup. Four short lines, one time, so the first wake of
  // the day is as fast as the hundredth.
  async prewarm() {
    if (!this.enabled() || !this.voice) return 0;
    let warmed = 0;
    for (const entry of Object.values(CUE_TEXT)) {
      if (!entry) continue;
      for (const text of Object.values(entry)) {
        if (await this.ensure(text)) warmed += 1;
      }
    }
    this.counters?.bump?.("cue_prewarmed");
    return warmed;
  }

  // The cue's own text is what comes back through the pendant mic a beat later.
  // Registering it BEFORE the socket send is the same ordering discipline
  // AckSink.handleAck uses for the echo fingerprint: the window has to be open
  // before the sound exists.
  registerEcho(echoGuard, speak) {
    if (!echoGuard || !speak?.text) return;
    echoGuard.registerShort(speak.text);
  }
}

export { detectLanguage };
