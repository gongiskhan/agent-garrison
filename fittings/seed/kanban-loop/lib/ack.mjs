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

const ACK_KINDS = ["captured", "created", "started", "completed", "failed"];
const SLOT_RE = /\{([a-z_][a-z0-9_]*)\}/gi;

// A template that interpolates nothing renders the same sentence for every event,
// which is the "Done" failure the referent rule exists to prevent. Enforced on
// load so a bad edit is caught at startup rather than in the operator's ear.
export function validateTemplate(id, tpl) {
  const problems = [];
  if (!tpl || typeof tpl !== "object") return [`${id}: not an object`];
  if (!ACK_KINDS.includes(tpl.kind)) problems.push(`${id}: kind must be one of ${ACK_KINDS.join("|")}`);
  if (tpl.severity !== "info" && tpl.severity !== "error") problems.push(`${id}: severity must be info|error`);
  if (typeof tpl.text !== "string" || !tpl.text.trim()) problems.push(`${id}: text is required`);
  const declared = Array.isArray(tpl.slots) ? tpl.slots : [];
  const used = [...String(tpl.text ?? "").matchAll(SLOT_RE)].map((m) => m[1]);
  if (used.length === 0) problems.push(`${id}: template names no referent (every ack must say what it is about)`);
  for (const u of used) if (!declared.includes(u)) problems.push(`${id}: text uses undeclared slot {${u}}`);
  return problems;
}

// Registry load order: the fitting's committed defaults, overlaid by an operator
// edit at $GARRISON_HOME/kanban-loop/ack-templates.json. An invalid overlay is
// REFUSED WHOLE rather than merged - half an edit is a registry nobody can reason
// about, and the defaults are always a working fallback.
export function loadTemplates({ env = process.env, log = console } = {}) {
  const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  const file = path.join(home, "kanban-loop", "ack-templates.json");
  let overlay = null;
  try {
    overlay = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_TEMPLATES };
  }
  const merged = { ...DEFAULT_TEMPLATES, ...overlay };
  const problems = Object.entries(merged).flatMap(([id, tpl]) => validateTemplate(id, tpl));
  if (problems.length > 0) {
    log.warn?.(`[kanban-loop] ack-templates.json rejected (${problems.length} problem(s)): ${problems[0]}`);
    return { ...DEFAULT_TEMPLATES };
  }
  return merged;
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
// yet), `duty-summary` (a report, not an outcome), and `schedule-due` (a reminder
// the notification layer already delivers - an ack would say it twice).
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
export function ackFromOriginEvent(event, card, { templates = DEFAULT_TEMPLATES, env = process.env, now = () => new Date() } = {}) {
  if (!event || !card || !isAckableEventKind(event.kind)) return null;
  const subject = String(card.title ?? "").trim();
  if (!subject) return null; // no referent, no ack - see the referent rule above
  const templateId = EVENT_KIND_TO_TEMPLATE[event.kind];
  const tpl = templates[templateId];
  if (!tpl) return null;
  const slots = { subject };
  let text;
  try {
    text = renderAck(templateId, slots, { templates, env });
  } catch (err) {
    // A wake-word collision or a missing slot must not take out the card write
    // that produced the event. Losing an ack is recoverable; losing the card is
    // not, and a half-rendered sentence is worse than silence.
    return { skipped: err.code === "ACK_WAKE_COLLISION" ? "wake-collision" : "render-failed", reason: err.message };
  }
  return {
    id: `ack-${card.id}-${event.kind}`,
    kind: tpl.kind,
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
