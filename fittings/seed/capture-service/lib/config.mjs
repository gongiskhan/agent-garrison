// Capture service Fitting — config resolution.
//
// Everything comes from the spawn env the runner projects
// (GARRISON_CAPTURESERVICE_<KEY> per composition config key, vault secrets
// under their exact names per secret_scope). No literal port fallback beyond
// the committed default_port; no gateway port literal at all — an
// unresolvable gateway means the dependent feature is skipped with a logged
// reason, never silently pointed at another instance's port.

import os from "node:os";
import path from "node:path";

export const FITTING_ID = "capture-service";
export const CHANNEL_ID = "companion";
export const DEFAULT_PORT = 7097; // base-family (dev); prod arrives shifted via GARRISON_CAPTURESERVICE_PORT

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set) IS
// the .garrison root, else ~/.garrison. Sandboxed tests set it so state and
// status files never collide with a live instance.
export function garrisonDir(env = process.env) {
  const override = env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

// Durable state root for this fitting (sessions, transcripts, media, capture
// events, device registry). Convention: $GARRISON_HOME/<area>, dedicated
// override so the shared triage tick can be pointed at a sandboxed root.
export function captureDir(env = process.env) {
  const override = env.GARRISON_CAPTURE_DIR?.trim();
  return override && override.length > 0 ? override : path.join(garrisonDir(env), "capture");
}

export function statusFilePath(env = process.env) {
  return path.join(garrisonDir(env), "ui-fittings", `${FITTING_ID}.json`);
}

function parseBool(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function parseIntOr(raw, fallback) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCsv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Same default set as omi-channel's config (the operative answers to Zeca);
// the byte-identical wake module copied from there consumes it. Kept as a
// plain default here rather than re-implementing the retired-variant
// compatibility read: this fitting shipped after the rename, so no install
// can hold a pre-rename value.
// "zecke" earned its place from a real transcript: nova-3 multi rendered the
// wake word as German "Zecke" (2026-08-13). language=pt makes that unlikely
// to recur, but the variant is cheap insurance against relapses.
export const DEFAULT_WAKE_VARIANTS = ["zeca", "zeka", "zecca", "zéca", "ze ca", "zecke"];

// Gateway URL resolution — GARRISON_GATEWAY_URL, else HOST/PORT pair when the
// port is explicitly numeric. NEVER a baked port literal. null = the
// gateway-dependent feature skips with a logged reason.
export function resolveGatewayUrl(env = process.env) {
  const direct = (env.GARRISON_GATEWAY_URL || "").trim();
  if (direct) return direct.replace(/\/$/, "");
  const p = (env.GARRISON_GATEWAY_PORT || "").trim();
  if (/^\d+$/.test(p)) {
    const h = (env.GARRISON_GATEWAY_HOST || "127.0.0.1").trim();
    return `http://${h}:${p}`;
  }
  return null;
}

export function loadConfig(env = process.env) {
  return {
    port: parseIntOr(env.GARRISON_CAPTURESERVICE_PORT, DEFAULT_PORT),
    bindHost:
      (env.GARRISON_CAPTURESERVICE_BIND_HOST || "").trim() ||
      (env.GARRISON_BIND_HOST || "").trim() ||
      "127.0.0.1",
    gatewayUrl: resolveGatewayUrl(env),

    // Resolved instance paths, carried ON the config. Every consumer derives
    // state from the config it was handed; nothing re-reads process.env behind
    // the caller's back (the omi-channel 2026-07-30 lesson: an ambient re-read
    // let a sandboxed test delete a LIVE instance's status file).
    home: garrisonDir(env),
    stateDir: captureDir(env),
    statusFile: statusFilePath(env),

    // Independent kill switches (invariant I9) — every pipe defaults OFF.
    enabled: parseBool(env.GARRISON_CAPTURESERVICE_ENABLED, false), // master: session + device ingress
    transcribeEnabled: parseBool(env.GARRISON_CAPTURESERVICE_TRANSCRIBE_ENABLED, false),
    wakeEnabled: parseBool(env.GARRISON_CAPTURESERVICE_WAKE_ENABLED, false),
    notifyEnabled: parseBool(env.GARRISON_CAPTURESERVICE_NOTIFY_ENABLED, false),
    speakEnabled: parseBool(env.GARRISON_CAPTURESERVICE_SPEAK_ENABLED, false),
    // Pendant Direct (ADR D5/D6): the pendant path has its own kill switch,
    // independent of the companion flags and of the omi channel entirely.
    pendantEnabled: parseBool(env.GARRISON_CAPTURESERVICE_PENDANT_ENABLED, false),
    // Applies ONLY to mode:"pendant" sessions. Under wake_only (the default)
    // nothing but the wake path persists: no media log, no transcript, no
    // session capture_event - counters only. Under ambient the session
    // persists exactly like a companion session and feeds triage.
    capturePolicy: (() => {
      const v = (env.GARRISON_CAPTURESERVICE_CAPTURE_POLICY || "").trim().toLowerCase();
      return v === "ambient" ? "ambient" : "wake_only";
    })(),

    // Deepgram live transcription (M2). Model/language verified against the
    // current docs when the client is written; shapes in docs/api-notes.md.
    //
    // language defaults to "pt", NOT "multi": replaying real captured
    // sessions (2026-08-13 forensics) proved nova-3 multi's streaming
    // language-ID locks onto the wrong language (German/Italian) from the
    // short, quiet, name-initial head of a wake utterance and renders
    // Portuguese audio as garbage ("Zeca" -> "ZeckeSäcke"), while the same
    // packets pinned to pt transcribe near-perfectly. English words inside a
    // PT-pinned stream still come out usable (helped by stt_keyterms).
    sttModel: (env.GARRISON_CAPTURESERVICE_STT_MODEL || "").trim() || "nova-3",
    sttLanguage: (env.GARRISON_CAPTURESERVICE_STT_LANGUAGE || "").trim() || "pt",
    // Keyterm prompting (nova-3): lifts the wake word from conf ~0.74 to
    // 0.99-1.0 on real captures and rescues embedded English product words.
    sttKeyterms: (() => {
      const v = parseCsv(env.GARRISON_CAPTURESERVICE_STT_KEYTERMS);
      return v.length > 0 ? v : ["Zeca", "companion"];
    })(),
    // Zeca's voice (ADR: ElevenLabs over iOS AVSpeechSynthesizer). OFF by
    // default like every other pipe (I9); with it off, or with no key, the
    // phone keeps speaking in its own synthesizer and nothing else changes.
    ttsEnabled: parseBool(env.GARRISON_CAPTURESERVICE_TTS_ENABLED, false),
    // Diogo - a NATIVE European Portuguese library voice, warm and
    // conversational. The 28-palavras forensics are unambiguous that a native
    // pt voice beats any premade voice plus prompting: premade voices drift to
    // pt-BR on short clips, which is the shape of everything Zeca says.
    ttsVoiceId: (env.GARRISON_CAPTURESERVICE_TTS_VOICE_ID || "").trim() || "RlGHmE2fztwdBDat0jYf",
    // multilingual_v2, NOT v3: v3 rejects previous_text/next_text, and those
    // unspoken pt-PT anchors are the accent fix.
    ttsModel: (env.GARRISON_CAPTURESERVICE_TTS_MODEL || "").trim() || "eleven_multilingual_v2",
    ttsCacheMaxClips: parseIntOr(env.GARRISON_CAPTURESERVICE_TTS_CACHE_MAX_CLIPS, 500),
    // Zombie-socket watchdog: reconnect the STT socket when we have been
    // feeding it audio this recently and NOTHING has come back for this long.
    // Generous on purpose - Deepgram is legitimately silent through a quiet
    // room, and the KeepAlive we send when audio goes quiet means a healthy far
    // end is never mute for minutes. 0 disables.
    transcribeMuteTimeoutMs: parseIntOr(env.GARRISON_CAPTURESERVICE_TRANSCRIBE_MUTE_TIMEOUT_MS, 120000),
    // Test hooks (omi's OMI_API_BASE_URL precedent): redirect the live STT
    // socket / the APNs gateway to local mocks so sandboxed E2E runs never
    // need real keys. Env-only, never in config_schema — production always
    // talks to the real endpoints.
    dgBaseUrl: (env.GARRISON_CAPTURESERVICE_DG_URL || "").trim() || null,
    apnsBaseUrl: (env.GARRISON_CAPTURESERVICE_APNS_URL || "").trim() || null,

    // Classification pin (the 82-second lesson) and delegation budget — same
    // two-lane split as omi-channel.
    classifyTarget: (() => {
      const raw = env.GARRISON_CAPTURESERVICE_CLASSIFY_TARGET;
      return raw === undefined ? "cc-haiku-low" : String(raw).trim();
    })(),
    delegateEnabled: parseBool(env.GARRISON_CAPTURESERVICE_DELEGATE_ENABLED, true),
    delegateTimeoutMs: parseIntOr(env.GARRISON_CAPTURESERVICE_DELEGATE_TIMEOUT_MS, 10 * 60 * 1000),

    // Wake bus (M3) — consumed by the byte-identical wake module copy.
    wakeVariants: (() => {
      const v = parseCsv(env.GARRISON_CAPTURESERVICE_WAKE_VARIANTS);
      return v.length > 0 ? v : [...DEFAULT_WAKE_VARIANTS];
    })(),
    wakeSilenceCloseMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_SILENCE_CLOSE_MS, 4000),
    wakeSettledCloseMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_SETTLED_CLOSE_MS, 5000),
    wakeMaxCaptureMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_MAX_CAPTURE_MS, 20000),
    wakeMinCaptureMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_MIN_CAPTURE_MS, 0),
    wakeCommandWindowMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_COMMAND_WINDOW_MS, 60000),
    // How long a wake pulse fired off an unstable Deepgram INTERIM waits for
    // the authoritative final to confirm it. Sized to one utterance, not to the
    // capture window: measured interim-to-final gaps on live pendant finals run
    // p90 ~5s, max ~6.8s. Deliberately NOT derived from wakeMaxCaptureMs - it
    // used to be, and raising the capture window silently stretched the wearer's
    // dedupe blackout to a minute.
    wakeProvisionalTtlMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_PROVISIONAL_TTL_MS, 8000),
    wakeContextSegments: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_CONTEXT_SEGMENTS, 6),
    wakeContextMaxAgeMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_CONTEXT_MAX_AGE_MS, 120000),
    wakeCardDedupeMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_CARD_DEDUPE_MS, 600000),
    // Which language the wake path confirms in. "auto" (the default) reads it
    // off what the user actually said; an explicit pt/en pins it.
    wakeLanguage: (() => {
      const v = (env.GARRISON_CAPTURESERVICE_WAKE_LANGUAGE || "").trim().toLowerCase();
      return v === "pt" || v === "en" ? v : null;
    })(),
    // The revision pass (byte-identical wake module): keep listening after a
    // card is created for a spoken correction; one model call, once, at the
    // end. 0 disables.
    wakeReviseAfterMs: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_REVISE_AFTER_MS, 600000),
    wakeReviseMaxSegments: parseIntOr(env.GARRISON_CAPTURESERVICE_WAKE_REVISE_MAX_SEGMENTS, 50),

    // Outbound push (M5)
    notifyMaxPerDay: parseIntOr(env.GARRISON_CAPTURESERVICE_NOTIFY_MAX_PER_DAY, 50),
    // Separate budget for pushes that answer the user's own spoken commands
    // (wake confirmations, asks) — routine fan-out can never starve these.
    notifyInteractiveMaxPerDay: parseIntOr(env.GARRISON_CAPTURESERVICE_NOTIFY_INTERACTIVE_MAX_PER_DAY, 200),
    apnsEnvironment:
      (env.GARRISON_CAPTURESERVICE_APNS_ENVIRONMENT || "").trim().toLowerCase() === "sandbox"
        ? "sandbox"
        : "production",
    apnsTopic: (env.GARRISON_CAPTURESERVICE_APNS_TOPIC || "").trim() || "com.gomes.garrison",

    // Session lifecycle (M1)
    sessionIdleTimeoutMs: parseIntOr(env.GARRISON_CAPTURESERVICE_SESSION_IDLE_TIMEOUT_MS, 300000),

    // Triage wait-for-context floor (M4): a session ending under this many
    // transcript words is held as a thin fragment, not carded alone.
    minTranscriptWords: parseIntOr(env.GARRISON_CAPTURESERVICE_MIN_TRANSCRIPT_WORDS, 12),

    // Vault-scoped secrets (exact vault key names, delivered at spawn).
    secrets: {
      deepgramApiKey: (env.DEEPGRAM_API_KEY || "").trim(),
      captureToken: (env.CAPTURE_TOKEN || "").trim(),
      apnsTeamId: (env.APNS_TEAM_ID || "").trim(),
      apnsKeyId: (env.APNS_KEY_ID || "").trim(),
      apnsP8: (env.APNS_P8 || "").trim(),
      elevenLabsApiKey: (env.ELEVENLABS_API_KEY || "").trim()
    }
  };
}
