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
//
// Two backends since the voice layer folded in here (2026-09): ElevenLabs is
// still the voice with the accent work above; Deepgram Aura is the fallback
// that turns the DEEPGRAM_API_KEY the STT lane already needs into a read-aloud
// voice, so browser voice works with one key. `tts_backend` picks (auto =
// ElevenLabs if keyed, else Aura if keyed, else none); the phone, the browser
// and the automations connector all come through clipFor, so they share the
// one choice and the one cache.
//
// In auto mode a failed ElevenLabs render (the monthly quota wall, a dead key,
// an outage) is rendered again through Aura and ElevenLabs is PARKED for a
// while, so the next lines go straight to Aura instead of each paying a failed
// round trip first. Found 2026-09-04: the key reached the mesh with 0 credits
// left on the account, and every clip - acks included - failed until this.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./store.mjs";
import { detectLanguage } from "./lang.mjs";
import { SPEAK_TIMEOUT_MS, UpstreamError, speakClip, upstreamSignal } from "./deepgram-rest.mjs";

export { UpstreamError };

const API_BASE = "https://api.elevenlabs.io/v1";
// Unspoken conditioning that holds the accent on short lines. Never rendered -
// ElevenLabs uses it only to decide how the surrounding speech should sound.
const PT_ANCHOR_BEFORE = "Bom dia. Vamos ver com calma o que temos para hoje.";
const PT_ANCHOR_AFTER = " Muito bem. E assim mesmo que se diz aqui em Portugal.";
export const MAX_TEXT_CHARS = 600;
export const TTS_BACKENDS = ["elevenlabs", "deepgram"];
// How long a failed ElevenLabs call parks the voice on Aura before ElevenLabs
// is tried again. Long enough that a quota wall does not cost every line a
// failed round trip first; short enough that a top-up is heard within the hour.
export const FALLBACK_HOLD_MS = 15 * 60_000;

// Which engine renders a clip, given the config and the sealed keys. The
// answer is null with a reason when nothing can speak; "auto" walks the
// preference order, an explicit choice is honoured or refused, never
// silently swapped for the other backend.
export function resolveBackend(cfg) {
  const mode = String(cfg?.ttsBackend ?? "auto").trim().toLowerCase() || "auto";
  const hasEleven = Boolean(cfg?.secrets?.elevenLabsApiKey);
  const hasDeepgram = Boolean(cfg?.secrets?.deepgramApiKey);
  if (mode === "elevenlabs") {
    if (!hasEleven) return { backend: null, reason: "no ElevenLabs key" };
    if (!cfg.ttsVoiceId) return { backend: null, reason: "no voice configured" };
    return { backend: "elevenlabs" };
  }
  if (mode === "deepgram") {
    return hasDeepgram ? { backend: "deepgram" } : { backend: null, reason: "no DEEPGRAM_API_KEY" };
  }
  if (hasEleven && cfg.ttsVoiceId) return { backend: "elevenlabs" };
  if (hasDeepgram) return { backend: "deepgram" };
  return { backend: null, reason: "no TTS backend: neither ELEVENLABS_API_KEY nor DEEPGRAM_API_KEY is sealed" };
}

export function textSeed(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// The cache key covers everything that changes the AUDIO, not just the words:
// swapping voice, model or backend has to MISS, or a voice change would
// silently keep serving the old voice forever.
export function clipId({ text, voiceId, model, lang = null, backend = "elevenlabs" }) {
  // `lang` is in the key because it changes the AUDIO: it selects the pt-PT
  // anchors, and the same sentence rendered with and without them is a
  // different recording. Absent = "inferred", which is what every clip cached
  // before this behaved as - so old entries keep their old ids and simply age
  // out rather than being served for the wrong conditioning.
  const suffix = lang ? ` ${lang}` : "";
  // The ElevenLabs key input is the pre-backend one on purpose: every clip on
  // disk today was rendered by ElevenLabs, and re-keying them would re-render
  // (and re-bill, and un-freeze the accent of) every line Zeca has ever said.
  // Aura clips carry the backend name, so the two can never collide; on Aura
  // the model IS the voice, so no voice id enters the key.
  const input = backend === "deepgram" ? `deepgram ${model} ${text}${suffix}` : `${model} ${voiceId} ${text}${suffix}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
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
    // { since, until, reason } while ElevenLabs is parked and Aura speaks.
    this.fallback = null;
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
    const id = this.idFor(trimmed, lang);
    return this.readClip(id) ? { id, cached: true, backend: this.backend() } : null;
  }

  // The resolved engine name ("elevenlabs" | "deepgram") or null. Read by
  // /health and stamped on /tts as X-Voice-Backend; resolved on every call so
  // a config or key change at restart is reflected without a rebuild.
  backend() {
    const chosen = resolveBackend(this.cfg).backend;
    if (chosen === "elevenlabs" && this.canFallBack() && this.fallbackActive()) return "deepgram";
    return chosen;
  }

  // Auto mode may swap a failed ElevenLabs render for Aura; a pinned engine is
  // honoured or refused, never swapped (resolveBackend's contract).
  canFallBack() {
    const mode = String(this.cfg?.ttsBackend ?? "auto").trim().toLowerCase() || "auto";
    return mode === "auto" && Boolean(this.cfg?.secrets?.deepgramApiKey);
  }

  fallbackActive() {
    if (!this.fallback) return false;
    if (this.now() >= this.fallback.until) {
      this.fallback = null;
      return false;
    }
    return true;
  }

  // The parked state for /health: null, or { since, until, reason }.
  degraded() {
    return this.fallbackActive() ? { ...this.fallback } : null;
  }

  park(err) {
    const fresh = !this.fallbackActive();
    const at = this.now();
    this.fallback = {
      since: this.fallback?.since ?? at,
      until: at + FALLBACK_HOLD_MS,
      reason: String(err?.message ?? err).slice(0, 200)
    };
    this.counters.bump("tts_fallback_deepgram");
    if (fresh) {
      this.log.error(
        `[capture-service] tts parked on deepgram for ${Math.round(FALLBACK_HOLD_MS / 60_000)} min: ${this.fallback.reason}`
      );
    }
  }

  available() {
    if (!this.cfg.ttsEnabled) return { ok: false, reason: "tts disabled" };
    const { backend, reason } = resolveBackend(this.cfg);
    if (!backend) return { ok: false, reason };
    return { ok: true, backend: this.backend() };
  }

  idFor(text, lang, backend = this.backend()) {
    return clipId({
      text,
      voiceId: this.cfg.ttsVoiceId,
      model: backend === "deepgram" ? this.cfg.ttsDeepgramModel : this.cfg.ttsModel,
      lang,
      backend
    });
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
    try {
      return await this.render(text, { lang });
    } catch {
      // Counted and logged where it happened (render); here it is only the
      // fallback contract: null, and the phone speaks the line itself.
      return null;
    }
  }

  // clipFor without the safety net: same cache, same in-flight dedupe, but an
  // upstream failure PROPAGATES (as UpstreamError when the far end answered).
  // The voice REST surface needs the failure to answer an honest 502 with the
  // upstream status; the ack lane keeps using clipFor.
  async render(text, { lang = null } = {}) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return null;
    const avail = this.available();
    if (!avail.ok) return null;
    if (trimmed.length > MAX_TEXT_CHARS) {
      // Long text is the session answering a question. Speaking it is
      // desirable, but it is also the whole monthly budget in a handful of
      // replies - so it stays on the phone's own voice until someone raises
      // the cap deliberately.
      this.counters.bump("tts_skipped_too_long");
      return null;
    }
    return this.renderVia(avail.backend, trimmed, lang);
  }

  // One engine's cache + in-flight dedupe. An ElevenLabs failure in auto mode
  // parks ElevenLabs and renders the same line through Aura, under Aura's own
  // clip id, so the fallback clip never masquerades as the ElevenLabs one.
  async renderVia(backend, text, lang) {
    const id = this.idFor(text, lang, backend);
    if (this.readClip(id)) {
      this.counters.bump("tts_cache_hits");
      return { id, cached: true, backend };
    }
    if (this.inFlight.has(id)) return this.inFlight.get(id);
    const work = this.generate(text, id, lang, backend)
      .catch((err) => {
        this.counters.bump("tts_failures");
        this.counters.bump(`tts_failures_${backend}`);
        this.log.error(`[capture-service] tts failed (${backend}): ${err?.message ?? err}`);
        if (backend !== "elevenlabs" || !this.canFallBack()) throw err;
        this.park(err);
        return this.renderVia("deepgram", text, lang);
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, work);
    return work;
  }

  async generate(text, id, lang = null, backend = "elevenlabs") {
    const startedAt = this.now();
    const audio =
      backend === "deepgram"
        ? await speakClip({ cfg: this.cfg, text, fetchImpl: this.fetch })
        : await this.generateElevenLabs(text, lang);
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.clipPath(id), audio);
    this.counters.bump("tts_generated");
    this.counters.bump(`tts_generated_${backend}`);
    this.counters.observe("tts_generate_ms", this.now() - startedAt);
    this.counters.observe("tts_characters", text.length);
    this.pruneCache();
    return { id, cached: false, backend };
  }

  async generateElevenLabs(text, lang = null) {
    // A known language beats a guess every time; the guess remains for callers
    // that genuinely have nothing (a raw ack posted by another fitting).
    const portuguese = lang ? lang === "pt" : looksPortuguese(text);
    let res;
    try {
      res = await this.fetch(`${API_BASE}/text-to-speech/${this.cfg.ttsVoiceId}?output_format=mp3_44100_128`, {
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
        }),
        signal: upstreamSignal(SPEAK_TIMEOUT_MS)
      });
    } catch (err) {
      throw new UpstreamError("elevenlabs", 0, err?.message ?? String(err), { cause: err });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 401 is a dead key and 429 is the monthly wall - except that ElevenLabs
      // also answers an exhausted account with 401 + code "quota_exceeded"
      // (seen 2026-09-04). Both walls deserve their own counter: degrading
      // quietly for a month is how you find out in November.
      const quota = res.status === 429 || /quota_exceeded/.test(detail);
      this.counters.bump(quota ? "tts_quota_exhausted" : "tts_http_errors");
      throw new UpstreamError("elevenlabs", res.status, detail);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new UpstreamError("elevenlabs", res.status, "empty audio");
    return audio;
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
