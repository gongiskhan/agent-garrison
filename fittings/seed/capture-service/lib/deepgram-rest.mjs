// Deepgram REST lane: whole clips in, whole results out.
//
// The live lane (deepgram-live.mjs) streams a session over a websocket. This
// module is the other shape Deepgram offers and the one the voice REST surface
// needs: POST /v1/listen with a recorded clip (the browser's push-to-talk, the
// phone's clip fallback, an automation transcribing a file) and POST /v1/speak
// for an Aura read-aloud when ElevenLabs is not the TTS backend.
//
// Same host and the same `Authorization: Token <key>` scheme as the socket
// (docs/api-notes.md); the base URL is cfg.dgRestBaseUrl, derived from the one
// GARRISON_CAPTURESERVICE_DG_URL test hook so a sandbox points both lanes at a
// single mock.
//
// Log privacy (invariant I5) holds here too: an error carries the upstream
// status and a bounded excerpt of its TEXT body, never the audio and never the
// key.

import { applyAliases } from "./pronunciation-aliases.mjs";

const DETAIL_MAX_CHARS = 200;

// Every upstream call is bounded. Without a signal an undici fetch waits on a
// stalled connection indefinitely, which here means a /stt or /tts request (and
// the browser behind it) hanging until the client gives up. Transcription gets
// the longer budget: a clip near the 25 MB ingress cap takes Deepgram a while.
export const LISTEN_TIMEOUT_MS = 60_000;
export const SPEAK_TIMEOUT_MS = 20_000;

export function upstreamSignal(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
}

// A failed upstream call, typed so the HTTP surface can map it to 502 with the
// upstream status and excerpt intact. `backend` names the service ("deepgram",
// "elevenlabs"); `status` is the upstream HTTP status, or 0 when the request
// never got an answer (network failure, timeout).
export class UpstreamError extends Error {
  constructor(backend, status, detail, { cause = null } = {}) {
    const excerpt = String(detail ?? "").slice(0, DETAIL_MAX_CHARS);
    super(`${backend} ${status || "unreachable"}${excerpt ? `: ${excerpt}` : ""}`);
    this.name = "UpstreamError";
    this.backend = backend;
    this.status = Number.isInteger(status) ? status : 0;
    this.detail = excerpt;
    if (cause) this.cause = cause;
  }
}

function tokenHeader(cfg) {
  return { authorization: `Token ${cfg.secrets.deepgramApiKey}` };
}

async function upstreamText(res) {
  try {
    return (await res.text()).slice(0, DETAIL_MAX_CHARS);
  } catch {
    return "";
  }
}

// One recorded clip -> { transcript, confidence, language, model }.
//
// `language` defaults to cfg.sttRestLanguage (itself defaulting to
// stt_language); `contentType` is whatever the caller recorded (audio/webm
// from a browser MediaRecorder, audio/m4a from the phone). Throws UpstreamError
// on a non-2xx answer or a transport failure; the caller decides what a
// failure costs (the REST surface answers 502, never a fabricated transcript).
export async function transcribeClip({ cfg, bytes, contentType = "audio/webm", language = null, fetchImpl = null, timeoutMs = LISTEN_TIMEOUT_MS }) {
  if (!cfg?.secrets?.deepgramApiKey) throw new Error("DEEPGRAM_API_KEY not sealed");
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("empty audio");
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  const lang = String(language ?? "").trim() || cfg.sttRestLanguage || cfg.sttLanguage;
  const model = cfg.sttModel;
  const params = new URLSearchParams({ model, smart_format: "true", punctuate: "true", language: lang });
  // Same keyterm bias as the live lane (deepgram-live.mjs) - this lane was
  // missing it entirely, so a clip transcription got none of the lift a live
  // pendant session does for the same words.
  for (const term of cfg.sttKeyterms ?? []) params.append("keyterm", term);
  let res;
  try {
    res = await doFetch(`${cfg.dgRestBaseUrl}/v1/listen?${params}`, {
      method: "POST",
      headers: { ...tokenHeader(cfg), "content-type": contentType || "audio/webm" },
      body: bytes,
      signal: upstreamSignal(timeoutMs)
    });
  } catch (err) {
    throw new UpstreamError("deepgram", 0, err?.message ?? String(err), { cause: err });
  }
  if (!res.ok) throw new UpstreamError("deepgram", res.status, await upstreamText(res));
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new UpstreamError("deepgram", res.status, "non-JSON body", { cause: err });
  }
  const alt = data?.results?.channels?.[0]?.alternatives?.[0] ?? {};
  const transcript = typeof alt.transcript === "string" ? alt.transcript : "";
  return {
    transcript: cfg.sttAliases ? applyAliases(transcript, cfg.sttAliases) : transcript,
    confidence: typeof alt.confidence === "number" ? alt.confidence : null,
    language: lang,
    model
  };
}

// One line of text -> mp3 bytes, spoken by an Aura voice (cfg.ttsDeepgramModel;
// on Aura the model IS the voice). Throws UpstreamError like transcribeClip.
export async function speakClip({ cfg, text, fetchImpl = null, timeoutMs = SPEAK_TIMEOUT_MS }) {
  if (!cfg?.secrets?.deepgramApiKey) throw new Error("DEEPGRAM_API_KEY not sealed");
  const line = String(text ?? "").trim();
  if (!line) throw new Error("empty text");
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  const params = new URLSearchParams({ model: cfg.ttsDeepgramModel });
  let res;
  try {
    res = await doFetch(`${cfg.dgRestBaseUrl}/v1/speak?${params}`, {
      method: "POST",
      headers: { ...tokenHeader(cfg), "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: line }),
      signal: upstreamSignal(timeoutMs)
    });
  } catch (err) {
    throw new UpstreamError("deepgram", 0, err?.message ?? String(err), { cause: err });
  }
  if (!res.ok) throw new UpstreamError("deepgram", res.status, await upstreamText(res));
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new UpstreamError("deepgram", res.status, "empty audio");
  return audio;
}
