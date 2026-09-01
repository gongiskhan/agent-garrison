// Zeca's voice (2026-08-27).
//
// The companion app has always spoken through iOS AVSpeechSynthesizer, which is
// intelligible and robotic. This renders the same line with ElevenLabs instead
// and hands the phone an audio clip to play; the phone keeps its synthesizer as
// the fallback, so a missing key, a quota wall or a dead network costs quality,
// never the acknowledgement itself.
//
// EVERY non-obvious decision here is inherited from the 28-palavras app, which
// solved European-Portuguese TTS the expensive way (server/src/providers/
// elevenlabs.ts + DECISIONS.md, 2026-08-15). Do not re-derive them:
//
//   * Native pt library voices beat any premade voice plus prompting. They need
//     a paid plan; this account has one.
//   * eleven_multilingual_v2, NOT eleven_v3, for short lines - with long
//     UNSPOKEN pt-PT anchors in previous_text/next_text. v3 rejects those
//     fields, and short v3 clips are exactly where the accent slid into
//     Brazilian (9 of 66 clips in one rated session, one into Spanish).
//   * A deterministic per-text seed, so one line always renders the same audio.
//     Without it the accent flips between runs of the same sentence.
//   * stability 0.75 / similarity_boost 0.75.
//
// Cost is the other half. The plan is ~30k characters a MONTH and it is shared
// with another app, so every clip is cached on disk under its content hash:
// Zeca's acks repeat constantly ("Card created: ...", "On it"), and a cache hit
// costs nothing and also freezes that line's accent forever.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./store.mjs";
import { detectLanguage } from "./lang.mjs";

const API_BASE = "https://api.elevenlabs.io/v1";
// Unspoken conditioning that holds the accent on short lines. Never rendered -
// ElevenLabs uses it only to decide how the surrounding speech should sound.
const PT_ANCHOR_BEFORE = "Bom dia. Vamos ver com calma o que temos para hoje.";
const PT_ANCHOR_AFTER = " Muito bem. E assim mesmo que se diz aqui em Portugal.";
const MAX_TEXT_CHARS = 600;

export function textSeed(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// The cache key covers everything that changes the AUDIO, not just the words:
// swapping voice or model has to MISS, or a voice change would silently keep
// serving the old voice forever.
export function clipId({ text, voiceId, model, lang = null }) {
  // `lang` is in the key because it changes the AUDIO: it selects the pt-PT
  // anchors, and the same sentence rendered with and without them is a
  // different recording. Absent = "inferred", which is what every clip cached
  // before this behaved as - so old entries keep their old ids and simply age
  // out rather than being served for the wrong conditioning.
  const suffix = lang ? ` ${lang}` : "";
  return createHash("sha256").update(`${model} ${voiceId} ${text}${suffix}`).digest("hex").slice(0, 32);
}

// Picks CONDITIONING, never words: the anchors apply only to Portuguese, so
// guessing wrong costs a slightly differently-conditioned clip, not a wrong
// language.
//
// Delegates to lang.mjs rather than carrying its own rule. The old local
// heuristic returned true on the FIRST accent or Portuguese stopword, which
// made "Buy a remote for the TV amanhã" Portuguese and "Comprar comando"
// English. UNDETERMINED stays false here: with nothing to go on, the plain
// request without anchors is the safe rendering.
//
// Deliberately NOT parameterised by a caller-supplied language: clipId hashes
// {text, voiceId, model}, so if anything outside that triple could change the
// audio, one id would serve two different renderings.
export function looksPortuguese(text) {
  return detectLanguage(text) === "pt";
}

export class ZecaVoice {
  constructor({ cfg, counters, log = console, fetchImpl = null, now = () => Date.now() }) {
    this.cfg = cfg;
    this.counters = counters;
    this.log = log;
    this.fetch = fetchImpl ?? ((...args) => fetch(...args));
    this.now = now;
    this.dir = path.join(cfg.stateDir, "tts-cache");
    this.inFlight = new Map(); // clipId -> Promise, so a repeated line generates once
    // Clip ids that pruneCache may never evict. The spoken CUES live here: they
    // are a handful of fixed lines rendered once at boot, and pruning is
    // oldest-mtime-first, so without this they are guaranteed to fall out behind
    // ttsCacheMaxClips distinct card titles and then be missing at the exact
    // moment latency matters most.
    this.pinned = new Set();
  }

  pin(id) {
    if (/^[0-9a-f]{8,64}$/.test(String(id ?? ""))) this.pinned.add(String(id));
  }

  // The SYNCHRONOUS half of clipFor: is this line already on disk?
  //
  // Exists because the feedback lane must never await TTS. clipFor is async and
  // can reach ElevenLabs; awaiting it in the feedback subscriber would delay the
  // socket send, therefore the device haptic, therefore wake_to_device_ack_ms -
  // and the whole point of a wake cue is that it is immediate. A miss here is
  // not a failure: the phone speaks the line in its own voice instead.
  cachedClipFor(text, { lang = null } = {}) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || !this.available().ok) return null;
    const id = clipId({ text: trimmed, voiceId: this.cfg.ttsVoiceId, model: this.cfg.ttsModel, lang });
    return this.readClip(id) ? { id, cached: true } : null;
  }

  available() {
    if (!this.cfg.ttsEnabled) return { ok: false, reason: "tts disabled" };
    if (!this.cfg.secrets?.elevenLabsApiKey) return { ok: false, reason: "no ElevenLabs key" };
    if (!this.cfg.ttsVoiceId) return { ok: false, reason: "no voice configured" };
    return { ok: true };
  }

  clipPath(id) {
    return path.join(this.dir, `${id}.mp3`);
  }

  // The id is used to build a filesystem path from a value that reaches the
  // server over HTTP, so it is validated as a hex hash and never trusted.
  readClip(id) {
    if (!/^[0-9a-f]{8,64}$/.test(String(id ?? ""))) return null;
    const file = this.clipPath(id);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file);
    } catch {
      return null;
    }
  }

  // Returns { id } for a playable clip, or null when the phone should fall back
  // to its own synthesizer. NEVER throws: the voice is a nicety, and an ack
  // that fails to arrive because the nicety broke is a bug.
  // `lang` is the language the CALLER already resolved. Passing it matters:
  // inferring from the text alone silently mis-rendered the lines with no
  // accents and no Portuguese stopwords - "Deixa comigo.", "Feito." - which
  // then went out unanchored and drifted Brazilian. Those are short cues the
  // wearer hears constantly, so the drift was the voice they heard most.
  async clipFor(text, { lang = null } = {}) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return null;
    if (!this.available().ok) return null;
    if (trimmed.length > MAX_TEXT_CHARS) {
      // Long text is the operative answering a question. Speaking it is
      // desirable, but it is also the whole monthly budget in a handful of
      // replies - so it stays on the phone's own voice until someone raises
      // the cap deliberately.
      this.counters.bump("tts_skipped_too_long");
      return null;
    }
    const id = clipId({ text: trimmed, voiceId: this.cfg.ttsVoiceId, model: this.cfg.ttsModel, lang });
    if (this.readClip(id)) {
      this.counters.bump("tts_cache_hits");
      return { id, cached: true };
    }
    if (this.inFlight.has(id)) return this.inFlight.get(id);
    const work = this.generate(trimmed, id, lang)
      .catch((err) => {
        this.counters.bump("tts_failures");
        this.log.error(`[capture-service] tts failed: ${err?.message ?? err}`);
        return null;
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, work);
    return work;
  }

  async generate(text, id, lang = null) {
    // A known language beats a guess every time; the guess remains for callers
    // that genuinely have nothing (a raw ack posted by another fitting).
    const portuguese = lang ? lang === "pt" : looksPortuguese(text);
    const startedAt = this.now();
    const res = await this.fetch(
      `${API_BASE}/text-to-speech/${this.cfg.ttsVoiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.cfg.secrets.elevenLabsApiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: this.cfg.ttsModel,
          // The anchors ARE the accent fix, and multilingual v2 is the only
          // model that accepts them. They are meaningless around English.
          ...(portuguese ? { previous_text: PT_ANCHOR_BEFORE, next_text: PT_ANCHOR_AFTER } : {}),
          voice_settings: { stability: 0.75, similarity_boost: 0.75 },
          seed: textSeed(text)
        })
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 401 is a dead key and 429 is the monthly wall. Both deserve their own
      // counter: degrading quietly for a month is how you find out in November.
      this.counters.bump(res.status === 429 ? "tts_quota_exhausted" : "tts_http_errors");
      throw new Error(`elevenlabs ${res.status}: ${detail.slice(0, 200)}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new Error("elevenlabs returned empty audio");
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.clipPath(id), audio);
    this.counters.bump("tts_generated");
    this.counters.observe("tts_generate_ms", this.now() - startedAt);
    this.counters.observe("tts_characters", text.length);
    this.pruneCache();
    return { id, cached: false };
  }

  // Oldest-first prune. The cache exists to make REPEATS free, so it only has
  // to hold the lines Zeca actually repeats; unbounded, it would grow with
  // every distinct card title ever spoken.
  pruneCache() {
    const cap = this.cfg.ttsCacheMaxClips ?? 0;
    if (cap <= 0) return;
    let names;
    try {
      names = readdirSync(this.dir).filter((f) => f.endsWith(".mp3"));
    } catch {
      return;
    }
    if (names.length <= cap) return;
    const byAge = names
      .filter((f) => !this.pinned.has(f.replace(/\.mp3$/, "")))
      .map((f) => {
        const full = path.join(this.dir, f);
        try {
          return { full, at: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);
    for (const entry of byAge.slice(0, byAge.length - cap)) {
      try {
        unlinkSync(entry.full);
        this.counters.bump("tts_cache_evicted");
      } catch {}
    }
  }
}
