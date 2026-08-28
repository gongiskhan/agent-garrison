// Omi channel Fitting — config resolution.
//
// Everything comes from the spawn env the runner projects
// (GARRISON_OMICHANNEL_<KEY> per composition config key, vault secrets under
// their exact names per secret_scope). No literal port fallback beyond the
// committed default_port; no gateway port literal at all — an unresolvable
// gateway means the dependent feature is skipped with a logged reason, never
// silently pointed at another instance's port.

import os from "node:os";
import path from "node:path";

export const FITTING_ID = "omi-channel";
export const CHANNEL_ID = "omi";
export const DEFAULT_PORT = 7094; // base-family (dev); prod arrives shifted via GARRISON_OMICHANNEL_PORT

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set) IS
// the .garrison root, else ~/.garrison. Sandboxed tests set it so state and
// status files never collide with a live instance.
export function garrisonDir(env = process.env) {
  const override = env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

// Durable state root for this fitting (inbox events, counters, pinned uid,
// backfeed ledger). Convention: $GARRISON_HOME/<fitting>, dedicated override.
export function omiDir(env = process.env) {
  const override = env.GARRISON_OMI_DIR?.trim();
  return override && override.length > 0 ? override : path.join(garrisonDir(env), "omi");
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

// The operative answers to Zeca. Transcription is the reason this is a LIST and
// not a word: Deepgram hears a two-syllable Portuguese name ("ZEH-kah") through
// an English-leaning model and spells it several ways. Whitespace inside a
// variant is a SPLIT FORM - the transcriber sometimes breaks the name across a
// space or a hyphen - and wakeRegex() matches either.
//
// Deliberately NOT in this list: "seca" and "sega". Both are near-homophones and
// both are ordinary words ("seca" is Portuguese for dry), so they would wake the
// operative out of ambient conversation. A missed wake costs one repeat; a false
// wake captures speech the user never addressed to anyone.
export const DEFAULT_WAKE_VARIANTS = ["zeca", "zeka", "zecca", "zéca", "ze ca"];

// The pre-rename spellings (the operative was Gary until 2026-08-13). An install
// that still has these pinned in its composition config would wake on a name the
// operative no longer answers to and never wake on the one it does - a silent
// dead channel. So a stored value made up ENTIRELY of retired spellings is read
// as "unset" and falls through to the default above. A value the user actually
// customised (anything outside the retired set) is left exactly as configured.
// Read-only compatibility: nothing here is written back, and no new code carries
// both names.
const RETIRED_WAKE_VARIANTS = new Set(["gary", "garry", "gerry", "geri", "géri"]);

function foldVariant(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function isRetiredWakeVariantSet(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return false;
  return variants.every((v) => RETIRED_WAKE_VARIANTS.has(foldVariant(v)));
}

// Gateway URL resolution — GARRISON_GATEWAY_URL, else HOST/PORT pair when the
// port is explicitly numeric. NEVER a baked port literal (every baked port
// literal in this repo has crossed instances). null = gateway-dependent
// features skip with a reason.
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
    port: parseIntOr(env.GARRISON_OMICHANNEL_PORT, DEFAULT_PORT),
    bindHost:
      (env.GARRISON_OMICHANNEL_BIND_HOST || "").trim() ||
      (env.GARRISON_BIND_HOST || "").trim() ||
      "127.0.0.1",
    gatewayUrl: resolveGatewayUrl(env),

    // Resolved instance paths, carried ON the config. Every consumer derives
    // state from the config it was handed; nothing re-reads process.env behind
    // the caller's back. A caller holding a sandboxed cfg must never resolve to
    // the real ~/.garrison — server.mjs doing so let a test delete a LIVE
    // instance's status file (2026-07-30), which in turn breaks `down` (it kills
    // by pid from that file) and funnel-ensure (it reads the live port from it).
    home: garrisonDir(env),
    stateDir: omiDir(env),
    statusFile: statusFilePath(env),

    // Independent kill switches (invariant I9) — every pipe defaults OFF.
    enabled: parseBool(env.GARRISON_OMICHANNEL_ENABLED, false), // master: webhook ingress
    triageEnabled: parseBool(env.GARRISON_OMICHANNEL_TRIAGE_ENABLED, false),
    wakeEnabled: parseBool(env.GARRISON_OMICHANNEL_WAKE_ENABLED, false),
    notifyEnabled: parseBool(env.GARRISON_OMICHANNEL_NOTIFY_ENABLED, false),
    chatEnabled: parseBool(env.GARRISON_OMICHANNEL_CHAT_ENABLED, false),
    backfeedEnabled: parseBool(env.GARRISON_OMICHANNEL_BACKFEED_ENABLED, false),
    tipsEnabled: parseBool(env.GARRISON_OMICHANNEL_TIPS_ENABLED, false),

    // Public HTTPS base the human hands to Omi (the Funnel address, e.g.
    // https://<host>:8443). Used to build absolute URLs in the chat-tools
    // manifest; empty = manifest served with relative endpoints.
    publicBaseUrl: (env.GARRISON_OMICHANNEL_PUBLIC_BASE_URL || "").trim().replace(/\/$/, ""),

    // Triage (M2)
    triageCron: (env.GARRISON_OMICHANNEL_TRIAGE_CRON || "").trim() || "*/5 * * * *",
    triageBatchCap: parseIntOr(env.GARRISON_OMICHANNEL_TRIAGE_BATCH_CAP, 20),

    // The routing target every CLASSIFICATION call is pinned to (wake intent,
    // wake revision, batch triage). Unpinned, these land on the composition's
    // `other`/L1 duty cell - a full Sonnet agent-sdk turn carrying the whole
    // operative toolset, measured at 82s for one classification. Empty string
    // disables the pin and restores that behaviour.
    classifyTarget: (() => {
      const raw = env.GARRISON_OMICHANNEL_CLASSIFY_TARGET;
      return raw === undefined ? "cc-haiku-low" : String(raw).trim();
    })(),

    // Delegation to the full operative (the only path from a spoken command or
    // an Omi chat question to the operative's tools and connectors). Answers
    // arrive as a follow-up notification, so the budget is a real work budget,
    // not a wearer-waiting-on-it budget.
    delegateEnabled: parseBool(env.GARRISON_OMICHANNEL_DELEGATE_ENABLED, true),
    delegateTimeoutMs: parseIntOr(env.GARRISON_OMICHANNEL_DELEGATE_TIMEOUT_MS, 10 * 60 * 1000),

    // Scope filters (rule layer — zero model cost)
    allowedCategories: parseCsv(env.GARRISON_OMICHANNEL_ALLOWED_CATEGORIES), // empty = all
    blockedFolders: parseCsv(env.GARRISON_OMICHANNEL_BLOCKED_FOLDERS),
    dropDiscarded: parseBool(env.GARRISON_OMICHANNEL_DROP_DISCARDED, true),

    // Wake bus (M4)
    wakeVariants: (() => {
      const v = parseCsv(env.GARRISON_OMICHANNEL_WAKE_VARIANTS);
      if (v.length === 0 || isRetiredWakeVariantSet(v)) return [...DEFAULT_WAKE_VARIANTS];
      return v;
    })(),
    // Surfaced so the server can say ONCE at startup that a retired wake-word
    // config was ignored. Silently overriding a user's stored value is the kind
    // of thing that costs a day when the channel later behaves unexpectedly.
    wakeVariantsRetiredFallback: isRetiredWakeVariantSet(parseCsv(env.GARRISON_OMICHANNEL_WAKE_VARIANTS)),
    wakeSilenceCloseMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_SILENCE_CLOSE_MS, 4000),
    // Shorter close used only when the last segment ends a sentence. The full
    // silence window has to assume a mid-utterance gap; a punctuated ending says
    // there is no more coming, and paying the worst case every time is most of
    // the delay between speaking and hearing back. 0 disables (always wait the
    // full window). Ignored when it is not shorter than the full window.
    wakeSettledCloseMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_SETTLED_CLOSE_MS, 5000),
    wakeMaxCaptureMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_MAX_CAPTURE_MS, 20000),
    // Conversation context handed to the classifier on a wake hit. Omi
    // fragments speech across segments and mis-attributes speakers, so the
    // words that give a command its meaning are often in a segment BEFORE the
    // wake word - which the gate used to drop. 0 disables (pre-2026-07-31
    // behaviour: post-wake speech only). Bounded by count AND age so a hit can
    // never pull in unrelated conversation from earlier in the day.
    // Hold the capture window open for at least this long AFTER the wake word,
    // even through silence. Omi's transcript arrives in bursts with real gaps
    // inside a single sentence, so closing on the first quiet moment truncates
    // the command ("create a task saying" + nothing). 0 = close on silence as
    // before. The max-capture cap is still the hard ceiling.
    wakeMinCaptureMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_MIN_CAPTURE_MS, 0),
    // How much of the post-wake speech counts as THE COMMAND. Everything after
    // it is still captured but handed to the classifier as trailing context.
    // With an always-on mic in a room with a television the capture window can
    // run for minutes; without this split a 10-minute transcript of the TV
    // would drown the two sentences the user actually addressed to Zeca.
    wakeCommandWindowMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_COMMAND_WINDOW_MS, 60000),
    // The revision pass. The card is created fast so it can be SEEN and then
    // corrected out loud; this window is how long we keep listening for that
    // correction ("no, make it Wednesday", or just more detail). One model call
    // per revised card, once, at the end - not per segment. 0 disables.
    wakeReviseAfterMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_REVISE_AFTER_MS, 600000),
    wakeReviseMaxSegments: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_REVISE_MAX_SEGMENTS, 50),
    // Suppress a second card whose resolved title matches one just created.
    // A spoken command takes ~25s to appear, so repeating it is the natural
    // reaction - and the repeat is different transcript text, so nothing else
    // catches it. 0 disables.
    wakeCardDedupeMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_CARD_DEDUPE_MS, 600000),
    // The clarifying-question window: after Zeca SPEAKS a question, the next
    // utterance - no wake word - is taken as the answer. Short on purpose (an
    // always-on mic must not stay promiscuous), and rounds are capped so a
    // model that keeps asking stops being answered.
    wakeFollowupWindowMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_FOLLOWUP_WINDOW_MS, 12000),
    wakeFollowupMaxRounds: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_FOLLOWUP_MAX_ROUNDS, 3),
    // "Ainda estou a tratar disso." while a delegated turn runs - spoken only,
    // never pushed. 0 disables.
    wakeProgressIntervalMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_PROGRESS_INTERVAL_MS, 60000),
    // Say "Não percebi - repete?" when a wake window closes with nothing
    // usable, rather than leaving the wearer in silence after two cues.
    wakeUnheardEnabled: parseBool(env.GARRISON_OMICHANNEL_WAKE_UNHEARD_ENABLED, false),
    // Which language the wake path confirms in. "auto" (the default) reads it
    // off what the user actually said; an explicit pt/en pins it.
    wakeLanguage: (() => {
      const v = (env.GARRISON_OMICHANNEL_WAKE_LANGUAGE || "").trim().toLowerCase();
      return v === "pt" || v === "en" ? v : null;
    })(),
    wakeContextSegments: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_CONTEXT_SEGMENTS, 6),
    wakeContextMaxAgeMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_CONTEXT_MAX_AGE_MS, 120000),

    // Mirror every outbound message into the Omi CHAT as well as the push. The
    // push truncates and its tap target is the chat, so without this anything
    // longer than the notification line is unreadable and unrecoverable. Costs a
    // second API call per message and is bounded by Omi's 10/hour chat limit.
    chatDeliveryEnabled: parseBool(env.GARRISON_OMICHANNEL_CHAT_DELIVERY_ENABLED, true),

    // Outbound caps (M3)
    notifyMaxPerDay: parseIntOr(env.GARRISON_OMICHANNEL_NOTIFY_MAX_PER_DAY, 50),
    tipsMaxPerDay: parseIntOr(env.GARRISON_OMICHANNEL_TIPS_MAX_PER_DAY, 3),

    // Backfeed (M6)
    backfeedKinds: (() => {
      const v = parseCsv(env.GARRISON_OMICHANNEL_BACKFEED_KINDS);
      return v.length > 0 ? v : ["completed_cards", "decisions"];
    })(),

    // Vault-scoped secrets (exact vault key names, delivered at spawn).
    secrets: {
      appId: (env.OMI_APP_ID || "").trim(),
      appSecret: (env.OMI_APP_SECRET || "").trim(),
      importApiKey: (env.OMI_IMPORT_API_KEY || "").trim(),
      webhookSecret: (env.OMI_WEBHOOK_SECRET || "").trim()
    }
  };
}
