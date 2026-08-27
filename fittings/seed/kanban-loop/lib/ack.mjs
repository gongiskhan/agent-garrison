// Acknowledgements — the short spoken/felt confirmations that tell the operator
// something happened without them looking at a screen.
//
// An ack is NOT a notification. The notification still fires and still deep-links
// into the PWA; the ack is a second, much smaller class that exists to be heard.
// They differ in three ways that drive every decision in this file:
//
//   1. An ack is spoken, so it must NAME ITS REFERENT. Acks can arrive seconds
//      after the utterance that caused them, by which time "Done" is unusable.
//      Every template is therefore required to interpolate at least one slot.
//   2. An ack must NEVER be optimistic. A spoken "sent to Slack" for a message
//      that silently failed destroys trust in the whole layer within a week, at
//      which point the operator turns it off and this was all wasted. So acks are
//      built only from events that fire AFTER the underlying write is confirmed
//      (routeOriginEvent's post-CAS kinds), and `ackFromOriginEvent` refuses any
//      event kind whose outcome is not yet settled.
//   3. An ack is spoken INTO A LIVE MICROPHONE. The operator wears an always-on
//      pendant, so anything said aloud is transcribed and fed back into the same
//      pipeline that creates cards. See `echoFingerprint` and `assertSpeakable`.
//
// Text comes from a fixed registry, never from a model: an ack three seconds late
// is useless, and a generated sentence can confirm something that did not happen.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { detectLanguage, isLanguage, LANGUAGES } from "./lang.mjs";

// ---- the wake-word guard ----------------------------------------------------

// Mirrors wakeRegex in the omi-channel fitting. Fittings are self-contained APM
// packages and cross-fitting imports are forbidden, so this is copied rather than
// imported (the gateway-client precedent). It is a SAFETY check, not a feature:
// drift here fails closed (a stricter regex rejects more templates, it never lets
// a wake word through unnoticed).
//
// This guard carries MORE weight than it looks like it should. omi-channel's gate
// matches the token anywhere in a segment, with no address-position requirement,
// so a spoken sentence carrying the word ANYWHERE opens a capture window. That
// makes render-time rejection here the only thing standing between a voice sink
// and the pendant it speaks into.
const DEFAULT_WAKE_VARIANTS = ["zeca", "zeka", "zecca", "zéca", "ze ca"];

// Kept in step with omi-channel's config.mjs: a stored value made up entirely of
// the retired name's spellings is ignored there, so honouring it here would guard
// the WRONG word - the guard would pass an ack containing the live wake word.
// That is the one way this check can fail open, so the fallback is mirrored too.
const RETIRED_WAKE_VARIANTS = new Set(["gary", "garry", "gerry", "geri", "géri"]);

function fold(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function wakeVariants(env = process.env) {
  const raw = String(env.GARRISON_OMICHANNEL_WAKE_VARIANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) return [...DEFAULT_WAKE_VARIANTS];
  if (raw.every((v) => RETIRED_WAKE_VARIANTS.has(fold(v)))) return [...DEFAULT_WAKE_VARIANTS];
  return raw;
}

export function wakeRegex(variants) {
  const escaped = variants
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+"))
    .filter(Boolean);
  if (escaped.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

// Rendered ack text that contains the wake word would re-trigger the wake bus the
// moment it is spoken: the pendant hears "Zeca", opens a capture window, and the
// operator's next sentence becomes a command they never issued. Templates are
// authored so this cannot happen, but SLOTS are free text lifted from the
// operator's own request ("send Zeca the invoice"), so the check has to run at
// render time on the finished sentence, not once on the template.
export function assertSpeakable(text, env = process.env) {
  const re = wakeRegex(wakeVariants(env));
  if (re && re.test(text)) {
    const err = new Error(`ack text contains the wake word and would re-trigger capture: ${JSON.stringify(text)}`);
    err.code = "ACK_WAKE_COLLISION";
    throw err;
  }
  return text;
}

// ---- the template registry --------------------------------------------------

// Fixed set. `kind` and `severity` come from the template, never from the caller,
// so a "failed" ack can never be rendered with a success sentence. `slots` names
// what must be supplied; every template interpolates at least one of them, which
// is what makes the utterance self-describing seconds after the fact.
export const DEFAULT_TEMPLATES = {
  "card.created": {
    kind: "created",
    severity: "info",
    slots: ["subject"],
    text: "Created a task, {subject}.",
    short: "Created, {subject}."
  },
  "card.created.scheduled": {
    kind: "created",
    severity: "info",
    slots: ["subject", "when"],
    text: "Created an event, {subject}, {when}.",
    short: "Created, {subject}, {when}."
  },
  "card.completed": {
    kind: "completed",
    severity: "info",
    slots: ["subject"],
    text: "Finished {subject}.",
    short: "Finished {subject}."
  },
  "card.failed": {
    kind: "failed",
    severity: "error",
    slots: ["subject"],
    text: "Could not finish {subject}.",
    short: "Failed, {subject}."
  },
  "card.blocked": {
    kind: "failed",
    severity: "error",
    slots: ["subject"],
    text: "Stopped on {subject}, it needs you.",
    short: "Blocked, {subject}."
  },
  "capture.noted": {
    kind: "captured",
    severity: "info",
    slots: ["subject"],
    text: "Captured that, {subject}.",
    short: "Captured, {subject}."
  },
  "run.started": {
    kind: "started",
    severity: "info",
    slots: ["subject"],
    text: "Started {subject}.",
    short: "Started {subject}."
  },
  "integration.sent": {
    kind: "completed",
    severity: "info",
    slots: ["target"],
    text: "Sent the message to {target}.",
    short: "Sent to {target}."
  },
  "integration.failed": {
    kind: "failed",
    severity: "error",
    slots: ["target"],
    text: "Could not connect to {target}.",
    short: "{target} failed."
  }
};

// The same registry in European Portuguese, informal (tu): Zeca speaks to one
// person, who owns the machine.
//
// This exists because the ack was the one place the product spoke a sentence
// the user had not written. The card TITLE is always the user's own words - the
// classifier is told to keep their language - so an English frame around a
// Portuguese title produced "Created a task, Comprar comando para a
// televisão." Half a sentence in each language, out loud, is worse than either
// language alone.
//
// Every frame still interpolates a slot, so the referent rule holds in both.
export const PT_TEMPLATES = {
  "card.created": {
    kind: "created",
    severity: "info",
    slots: ["subject"],
    text: "Criei uma tarefa: {subject}.",
    short: "Criada: {subject}."
  },
  "card.created.scheduled": {
    kind: "created",
    severity: "info",
    slots: ["subject", "when"],
    text: "Criei um evento: {subject}, {when}.",
    short: "Criado: {subject}, {when}."
  },
  "card.completed": {
    kind: "completed",
    severity: "info",
    slots: ["subject"],
    text: "Terminei {subject}.",
    short: "Terminei {subject}."
  },
  "card.failed": {
    kind: "failed",
    severity: "error",
    slots: ["subject"],
    text: "Não consegui terminar {subject}.",
    short: "Falhou: {subject}."
  },
  "card.blocked": {
    kind: "failed",
    severity: "error",
    slots: ["subject"],
    text: "Parei em {subject}, precisa de ti.",
    short: "Bloqueado: {subject}."
  },
  "capture.noted": {
    kind: "captured",
    severity: "info",
    slots: ["subject"],
    text: "Apontei: {subject}.",
    short: "Apontado: {subject}."
  },
  "run.started": {
    kind: "started",
    severity: "info",
    slots: ["subject"],
    text: "Comecei {subject}.",
    short: "Comecei {subject}."
  },
  "integration.sent": {
    kind: "completed",
    severity: "info",
    slots: ["target"],
    text: "Enviei a mensagem para {target}.",
    short: "Enviado para {target}."
  },
  "integration.failed": {
    kind: "failed",
    severity: "error",
    slots: ["target"],
    text: "Não consegui ligar a {target}.",
    short: "{target} falhou."
  }
};

// English stays the flat DEFAULT_TEMPLATES so `renderAck(id, slots)` and every
// existing caller keep working unchanged; language selection happens strictly
// ABOVE the flat registry, never inside it.
export const TEMPLATES_BY_LANG = { en: DEFAULT_TEMPLATES, pt: PT_TEMPLATES };
export const ACK_LANGUAGES = LANGUAGES;

// `auto` (the shipped default) means "read the referent"; an explicit pt/en
// pins it and detection is never consulted.
export function ackLanguage(env = process.env) {
  const raw = String(env.GARRISON_KANBANLOOP_ACK_LANGUAGE ?? "").trim().toLowerCase();
  return isLanguage(raw) ? raw : null;
}

const ACK_KINDS = ["captured", "created", "started", "completed", "failed"];
const SLOT_RE = /\{([a-z_][a-z0-9_]*)\}/gi;

// A template that interpolates nothing renders the same sentence for every event,
// which is the "Done" failure the referent rule exists to prevent. Enforced on
// load so a bad edit is caught at startup rather than in the operator's ear.
export function validateTemplate(id, tpl, env = process.env) {
  const problems = [];
  if (!tpl || typeof tpl !== "object") return [`${id}: not an object`];
  if (!ACK_KINDS.includes(tpl.kind)) problems.push(`${id}: kind must be one of ${ACK_KINDS.join("|")}`);
  if (tpl.severity !== "info" && tpl.severity !== "error") problems.push(`${id}: severity must be info|error`);
  if (typeof tpl.text !== "string" || !tpl.text.trim()) problems.push(`${id}: text is required`);
  const declared = Array.isArray(tpl.slots) ? tpl.slots : [];
  const used = [...String(tpl.text ?? "").matchAll(SLOT_RE)].map((m) => m[1]);
  if (used.length === 0) problems.push(`${id}: template names no referent (every ack must say what it is about)`);
  for (const u of used) if (!declared.includes(u)) problems.push(`${id}: text uses undeclared slot {${u}}`);
  // A wake word in the FRAME is a different failure from one in a slot: a slot
  // is the operator's own words and can only be caught at render time, but a
  // template carrying the name would speak the pendant into a capture window on
  // every single ack. Catch that at load, not in the operator's ear.
  const frame = String(tpl?.text ?? "").replace(SLOT_RE, " ");
  try {
    assertSpeakable(frame, env);
  } catch (err) {
    if (err?.code === "ACK_WAKE_COLLISION") problems.push(`${id}: template text contains the wake word`);
    else throw err;
  }
  return problems;
}

// Registry load order: the fitting's committed defaults, overlaid by an operator
// edit at $GARRISON_HOME/kanban-loop/ack-templates.json. An invalid overlay is
// REFUSED WHOLE rather than merged - half an edit is a registry nobody can reason
// about, and the defaults are always a working fallback.
// An overlay is NESTED ({pt: {...}, en: {...}}) iff every top-level key is a
// language code. That is safe to discriminate on because template ids are
// dotted ("card.created") and can never be two letters.
//
// A FLAT overlay is the legacy shape, and it is applied to EVERY language on
// purpose. It was written when there was only one registry, so it is an
// explicit operator statement about what an ack should say; applying it to
// English only would silently change their acks the day Portuguese starts being
// picked, which is the one outcome nobody could debug.
function readOverlay(env) {
  const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  const file = path.join(home, "kanban-loop", "ack-templates.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length > 0 && keys.every((k) => ACK_LANGUAGES.includes(k))) return { shape: "nested", raw };
    return { shape: "flat", raw };
  } catch {
    return null;
  }
}

// -> { pt, en }. The all-or-nothing rule is unchanged and now spans every
// language: half an edit is a registry nobody can reason about, and the
// committed defaults are always a working fallback.
export function loadTemplateSets({ env = process.env, log = console } = {}) {
  const base = () => ({ en: { ...DEFAULT_TEMPLATES }, pt: { ...PT_TEMPLATES } });
  const overlay = readOverlay(env);
  if (!overlay) return base();
  const merged = base();
  for (const lang of ACK_LANGUAGES) {
    const patch = overlay.shape === "nested" ? overlay.raw[lang] : overlay.raw;
    if (patch && typeof patch === "object") merged[lang] = { ...merged[lang], ...patch };
  }
  const problems = ACK_LANGUAGES.flatMap((lang) =>
    Object.entries(merged[lang]).flatMap(([id, tpl]) => validateTemplate(id, tpl, env).map((p) => `${lang}/${p}`))
  );
  if (problems.length > 0) {
    log.warn?.(`[kanban-loop] ack-templates.json rejected (${problems.length} problem(s)): ${problems[0]}`);
    return base();
  }
  return merged;
}

// Kept returning a FLAT registry so every existing caller and test is
// unaffected; `lang` selects which one.
export function loadTemplates({ env = process.env, log = console, lang = "en" } = {}) {
  const sets = loadTemplateSets({ env, log });
  return sets[isLanguage(lang) ? lang : "en"];
}

// ---- rendering --------------------------------------------------------------

export function renderAck(templateId, slots = {}, { templates = DEFAULT_TEMPLATES, short = false, env = process.env } = {}) {
  const tpl = templates[templateId];
  if (!tpl) throw new Error(`unknown ack template: ${templateId}`);
  const form = short && tpl.short ? tpl.short : tpl.text;
  const missing = [];
  const text = form.replace(SLOT_RE, (_, name) => {
    const v = slots[name];
    if (v === undefined || v === null || String(v).trim() === "") {
      missing.push(name);
      return "";
    }
    return String(v).trim();
  });
  if (missing.length > 0) throw new Error(`ack ${templateId} missing slot(s): ${missing.join(", ")}`);
  return assertSpeakable(text.replace(/\s+/g, " ").trim(), env);
}

// A spoken ack is picked up by the operator's own pendant within a second or two,
// transcribed, and delivered back into the conversation pipeline that creates
// cards - so "Created a task, follow up with the lawyer" can card itself, forever.
// The fingerprint travels with the ack so an input channel can drop its own echo.
// Normalised the same way titles are (accent- and punctuation-insensitive),
// because the transcriber will not return the sentence verbatim.
export function echoFingerprint(text) {
  const norm = String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16);
}

// ---- building an ack from a confirmed event ---------------------------------

// The ONLY kinds an ack may be built from. Each is emitted by routeOriginEvent
// after the card write has been confirmed by saveCardCAS, which is what makes the
// no-optimistic-ack rule structural rather than a convention someone can forget.
// Kinds deliberately absent: `steering` and `needs-input` (mid-flight, no outcome
// yet), `duty-summary` (a report, not an outcome), `schedule-due` (a reminder
// the notification layer already delivers - an ack would say it twice), and
// `autonomy-acted` (§7.1), which is a THREAD LINE and not speech: the acting
// bands fire on ordinary work, so speaking each one would narrate the day rather
// than confirm an outcome. The four kinds below are outcomes; that is the rule.
const EVENT_KIND_TO_TEMPLATE = {
  created: "card.created",
  finished: "card.completed",
  failed: "card.failed",
  blocked: "card.blocked"
};

export function isAckableEventKind(kind) {
  return Object.prototype.hasOwnProperty.call(EVENT_KIND_TO_TEMPLATE, kind);
}

// -> ack object | null. Returns null (never throws) for anything not ackable, so
// a caller can hand it every event without filtering first.
// The language question, answered where the ack is built.
//
// This renders in kanban-loop, a different PROCESS from the capture-service
// that heard the utterance, so there is no ambient "what language are we in".
// Two routes, in order of authority:
//
//   1. card.lang - set by the wake bus, which decided from the whole spoken
//      command plus the classifier's output. Much better evidence than a title.
//   2. the card TITLE - which IS the user's own words, because the classifier
//      is instructed to keep their language. Every card has one, including
//      cards this pipeline never touched.
//
// A wrong answer can only ever pick the wrong FRAME; the referent is the user's
// own words either way. So the worst case is exactly today's behaviour.
export function ackLanguageFor(card, { lang = null, env = process.env, defaultLang = null } = {}) {
  if (isLanguage(lang)) return lang;
  if (isLanguage(card?.lang)) return card.lang;
  const detected = detectLanguage(card?.title ?? "");
  if (isLanguage(detected)) return detected;
  return ackLanguage(env) ?? (isLanguage(defaultLang) ? defaultLang : "en");
}

export function ackFromOriginEvent(
  event,
  card,
  { templates = null, templateSets = TEMPLATES_BY_LANG, lang = null, defaultLang = null, env = process.env, now = () => new Date() } = {}
) {
  if (!event || !card || !isAckableEventKind(event.kind)) return null;
  const subject = String(card.title ?? "").trim();
  if (!subject) return null; // no referent, no ack - see the referent rule above
  const templateId = EVENT_KIND_TO_TEMPLATE[event.kind];
  // An explicitly-passed flat registry wins outright and skips selection: that
  // is what a caller pinning one language (and every existing test) means.
  const resolvedLang = templates ? null : ackLanguageFor(card, { lang, env, defaultLang });
  const chosen = templates ?? templateSets[resolvedLang] ?? DEFAULT_TEMPLATES;
  const tpl = chosen[templateId];
  if (!tpl) return null;
  const slots = { subject };
  let text;
  try {
    text = renderAck(templateId, slots, { templates: chosen, env });
  } catch (err) {
    // A wake-word collision or a missing slot must not take out the card write
    // that produced the event. Losing an ack is recoverable; losing the card is
    // not, and a half-rendered sentence is worse than silence.
    return { skipped: err.code === "ACK_WAKE_COLLISION" ? "wake-collision" : "render-failed", reason: err.message };
  }
  return {
    id: `ack-${card.id}-${event.kind}`,
    kind: tpl.kind,
    lang: resolvedLang ?? null,
    severity: tpl.severity,
    templateId,
    slots,
    referent: subject.slice(0, 80),
    text,
    echo: echoFingerprint(text),
    cardId: card.id,
    emittedAt: now().toISOString(),
    sourceChannel: card.originChannel?.channel ?? card.origin ?? null,
    // The idempotency key the notification for this same event carries, so a sink
    // that sees both can tie them together and speak only once.
    idempotencyKey: typeof event.idempotencyKey === "string" ? event.idempotencyKey : null
  };
}
