// Web-channel conversation THREADS — a server-side transcript organizer.
//
// The operative is one rolling `claude --continue` conversation; "threads" are a
// generic, opaque-keyed organizer ON TOP of it so the web channel can list past
// conversations, show their history, and let the user move between them. The
// channel stays generic: a thread is just { id, title, source, mode, context,
// messages[] }. Kanban/Automations open a thread by passing a STABLE opaque key
// (+ optional title) on the URL; the channel never interprets the key.
//
// One file per thread under <garrison>/web-channel/threads/<id>.json. Listing
// scans the dir (a personal-scale store — a handful of small files). Writes are
// atomic (tmp + rename) so a crash mid-write never corrupts a transcript.
//
// Two run-context extras ride along (contract:
// docs/decisions/2026-07-25-web-channel-run-context.md §10, §12):
//   - per MESSAGE: `route` on an assistant message (the resolved RunAttribution,
//     including the routed runtime's OWN sessionId/transcriptPath) and `overrides`
//     on a user message (the pinned TurnRouting that was in force). Intent is kept
//     apart from what actually RAN.
//   - per THREAD: `routing`, the mutable pinned run context.
// Both go through the whitelist sanitizers below because `POST
// /api/threads/:id/messages` and the pin endpoint are CLIENT-reachable writes:
// without a whitelist a caller could grow a transcript file without bound or park
// prototype-shaped keys in it.
//
// The routed runtime also publishes canonical `session_event` envelopes. Unlike the
// flat messages above, these retain thinking, tool calls/results, inline result
// images, typed failures/rate limits/turn boundaries, and future permission prompts.
// They are durable thread state: updates reuse a stable event id with a higher
// revision and replace that event IN PLACE, preserving the original timeline.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiveEventStreamRegistry } from "../lib/live-event-stream.mjs";

function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const THREADS_DIR = path.join(garrisonDir(), "web-channel", "threads");

// Map any opaque key to a SAFE, stable filename stem. A key with only filesystem-
// unfriendly chars (or an over-long one) still gets a deterministic id via a hash
// suffix, so two distinct keys never collide after sanitising.
export function safeThreadId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  // If sanitising changed the key materially, append a short hash of the ORIGINAL
  // so distinct originals stay distinct (e.g. "a:b" vs "a-b").
  if (cleaned !== s) {
    const h = createHash("sha256").update(s).digest("hex").slice(0, 8);
    return `${cleaned || "thread"}-${h}`;
  }
  return cleaned;
}

// A fresh ad-hoc thread id (time-ordered + random tail; not a ULID, just unique).
export function newThreadId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `chat-${t}-${r}`;
}

function threadPath(id) {
  return path.join(THREADS_DIR, `${id}.json`);
}

// A per-process counter so two writes to the SAME thread inside one millisecond
// get distinct temp files. pid+Date.now() alone collided: a turn now writes the
// transcript and the session id back-to-back, and the loser's rename landed on a
// temp file the winner had already renamed away (ENOENT), losing that write.
let tmpSeq = 0;

async function atomicWriteJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${(tmpSeq = (tmpSeq + 1) % 1e6)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await rename(tmp, file);
}

// Atomic rename prevents a torn JSON file, but it does not make two independent
// read-modify-write operations atomic as a UNIT: both can read the same snapshot
// and the later rename then erases the earlier mutation. Keep one promise tail per
// normalized thread id so every in-process mutation observes its predecessor's
// committed state. Different threads remain fully concurrent. A rejected mutation
// is isolated to its caller; the fulfilled tail still lets the next write proceed.
const threadMutationTails = new Map();

function serializeThreadMutation(id, mutate) {
  const previous = threadMutationTails.get(id) ?? Promise.resolve();
  const result = previous.then(mutate);
  let tail;
  const release = () => {
    if (threadMutationTails.get(id) === tail) threadMutationTails.delete(id);
  };
  tail = result.then(release, release);
  threadMutationTails.set(id, tail);
  return result;
}

// ---------------------------------------------------------------------------
// Run-context sanitizers (whitelist only)
//
// These guard a client-reachable write path, so the rule is DROP, never coerce a
// blob: an unlisted key is discarded outright, strings are clipped, numbers must
// be finite integers in range, arrays are capped. Both sanitizers return a plain
// object built from scratch (never the caller's object) or null when nothing
// survived - null and absent mean the same thing to every consumer, so an
// all-null payload is stored as nothing at all rather than as key noise.
// ---------------------------------------------------------------------------

const ID_CLIP = 64; // ids, names, enum-ish labels
const TEXT_CLIP = 200; // paths, urls, human reasons
const LIST_CAP = 12; // overridesApplied / overridesRejected entries
// Never read these off a caller's object, whatever the whitelist says. JSON.parse
// keeps `__proto__` as an own data property rather than polluting, but this file
// also serves objects handed straight from an HTTP body parser, and the field maps
// below are edited by hand - an accidental entry must not become a live hazard.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Field -> validator kind. Anything absent from these maps is dropped.
// RouteAttribution, contract §1.
const ROUTE_META_FIELDS = {
  route: "id",
  runtime: "id",
  provider: "id",
  model: "id",
  effort: "id",
  effortApplied: "bool",
  taskType: "id",
  tier: "id",
  ruleId: "text", // "override:<target-id>" can outrun an id clip
  profile: "id",
  honored: "bool",
  duty: "id",
  level: "level",
  phase: "id",
  skill: "id",
  via: "id",
  account: "id",
  accountSource: "id",
  project: "id",
  projectPath: "text",
  card: "id",
  cardUrl: "text",
  sessionId: "id",
  transcriptPath: "text",
  stoppedByUser: "bool",
  stoppedReason: "text",
  overridesApplied: "strings",
  overridesRejected: "rejections",
  // `pending` is deliberately NOT persistable. It describes the FRAME ("this
  // attribution is provisional, the turn is still running"), not the turn, and the
  // server merges the pre-turn frame under the done payload - which carries no
  // `pending` key, so the pre-turn `true` would survive and a settled, persisted
  // turn would claim to still be in flight. A turn on disk has finished by
  // definition. turnSeq stays: which send produced this turn is a real fact.
  turnSeq: "seq",
};
// TurnRouting, contract §2. Deliberately NOT a superset of the above: a pin is the
// sparse INTENT, so resolved-only fields (runtime, provider, ruleId, via, …) are
// not pinnable and are dropped if sent.
const ROUTING_FIELDS = {
  target: "id",
  model: "id",
  effort: "id",
  duty: "id",
  level: "level",
  project: "id",
  account: "id",
  // RUN-SPEC-V1. Persisted like every other pin so a run plan chosen on the phone
  // is still in force from the laptop. Validated as opaque ids here on purpose: the
  // gateway owns the vocabulary (it is the process holding the compiled policy), and
  // a second copy of the phase/tier/flow lists in the channel would be a mirror
  // that silently drifts. An out-of-vocabulary value is refused there, with a reason
  // that reaches the badge.
  tier: "id",
  flow: "id",
  phasesOff: "id",
};

// Canonical session-event limits. Text uses the same explicit truncation marker as
// lib/session-transcript.mjs: silently slicing tool input/result text would make the
// durable transcript look complete when it is not. Images are intentionally not
// byte-capped here; a base64 result image is one atomic artifact and must remain
// decodable after reload.
const SESSION_TEXT_CAP = 20_000;
const SESSION_ID_CAP = 512;
const SESSION_LABEL_CAP = 1_000;
const INPUT_MESSAGE_CAP = 200_000;
const INPUT_QUEUE_CAP = 128;
const INPUT_QUEUE_BYTES_CAP = 2 * 1024 * 1024;
const INPUT_RECEIPT_CAP = 512;
const INPUT_ACTIVE_STATES = new Set(["queued", "starting", "running", "stopping"]);
const INPUT_TERMINAL_STATES = new Set(["settled", "stopped", "failed"]);
const PERMISSION_SUGGESTION_CAP = 64;
const PERMISSION_STATUSES = new Set(["pending", "resolved", "cancelled"]);
const PERMISSION_DECISIONS = new Set(["allow_once", "allow_always", "deny"]);
const SESSION_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "tool_progress",
  "related_task",
  "status",
  "error",
  "rate_limit",
  "turn_end",
  "permission_request",
]);
const INVALID_SESSION_VALUE = Symbol("invalid-session-value");

function cleanString(raw, max) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s ? s.slice(0, max) : null;
}

// Finite integer in [min,max] or null. A digits-only string is coerced: the rail's
// menus carry level/turnSeq through DOM data attributes, and silently dropping a
// pin the user set is worse than accepting "3".
function cleanInt(raw, min, max) {
  let n = raw;
  if (typeof n === "string" && /^-?\d+$/.test(n.trim())) n = Number(n.trim());
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  return n >= min && n <= max ? n : null;
}

function cleanField(kind, raw) {
  switch (kind) {
    case "id":
      return cleanString(raw, ID_CLIP);
    case "text":
      return cleanString(raw, TEXT_CLIP);
    case "bool":
      return typeof raw === "boolean" ? raw : null;
    // Duty levels are 1..9 everywhere in Garrison (contract §2, §11).
    case "level":
      return cleanInt(raw, 1, 9);
    // Monotonic per-send counter; non-negative, bounded by exact-integer range.
    case "seq":
      return cleanInt(raw, 0, Number.MAX_SAFE_INTEGER);
    case "strings": {
      if (!Array.isArray(raw)) return null;
      const out = [];
      for (const v of raw) {
        const s = cleanString(v, ID_CLIP);
        if (s) out.push(s);
        if (out.length >= LIST_CAP) break;
      }
      return out.length ? out : null;
    }
    case "rejections": {
      if (!Array.isArray(raw)) return null;
      const out = [];
      for (const v of raw) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const field = cleanString(v.field, ID_CLIP);
        const reason = cleanString(v.reason, TEXT_CLIP);
        // Both halves are the whole point of the record ("field X rejected
        // because Y"); half a record would render a lying badge.
        if (!field || !reason) continue;
        out.push({ field, reason });
        if (out.length >= LIST_CAP) break;
      }
      return out.length ? out : null;
    }
    default:
      return null;
  }
}

// Fields where an EXPLICIT null is a fact, not an absence, so it must survive a
// reload. The badge model reads `account: null` as "machine login" and
// `account: undefined` as "this lane cannot report an account" - two different
// truths. Dropping the null collapsed them, so a turn showed "machine login" live
// and no account badge at all after a refresh. Same for `skill: null` -> "skill: none".
// Everything else keeps the plain rule that null and absent are interchangeable.
const MEANINGFUL_NULL_FIELDS = new Set(["account", "skill"]);

function sanitizeAgainst(fields, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  let kept = 0;
  for (const [key, kind] of Object.entries(fields)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (!Object.hasOwn(raw, key)) continue; // inherited props are not data
    if (raw[key] === null && MEANINGFUL_NULL_FIELDS.has(key)) {
      out[key] = null;
      kept += 1;
      continue;
    }
    const value = cleanField(kind, raw[key]);
    if (value === null) continue;
    out[key] = value;
    kept += 1;
  }
  return kept ? out : null;
}

/** Whitelist a resolved RouteAttribution for persistence. */
export function sanitizeRouteMeta(raw) {
  return sanitizeAgainst(ROUTE_META_FIELDS, raw);
}

/** Whitelist a pinned TurnRouting for persistence. */
export function sanitizeRouting(raw) {
  return sanitizeAgainst(ROUTING_FIELDS, raw);
}

function cleanSessionId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  // Reject rather than truncate identity: two distinct overlong ids must never
  // collapse into the same durable event/session coordinate.
  return value && value.length <= SESSION_ID_CAP ? value : null;
}

function cleanInputId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= SESSION_ID_CAP ? value : null;
}

function cleanIso(raw) {
  if (typeof raw !== "string" || raw.length > ID_CLIP) return null;
  const value = raw.trim();
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function sanitizeClassification(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const key of ["taskType", "tier"]) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = cleanString(raw[key], ID_CLIP);
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizePendingInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const inputId = cleanInputId(raw.inputId);
  const clientRequestId = cleanInputId(raw.clientRequestId);
  const acceptedAt = cleanIso(raw.acceptedAt);
  const state = typeof raw.state === "string" && INPUT_ACTIVE_STATES.has(raw.state) ? raw.state : null;
  const message = typeof raw.message === "string" && raw.message.trim() && raw.message.length <= INPUT_MESSAGE_CAP
    ? raw.message
    : null;
  if (!inputId || !clientRequestId || !acceptedAt || !state || message === null) return null;
  const generationId = cleanInputId(raw.generationId);
  const startedAt = cleanIso(raw.startedAt);
  const routing = sanitizeRouting(raw.routing);
  const classification = sanitizeClassification(raw.classification);
  const turnSeq = cleanInt(raw.turnSeq, 0, Number.MAX_SAFE_INTEGER);
  return {
    inputId,
    clientRequestId,
    message,
    state,
    acceptedAt,
    ...(startedAt ? { startedAt } : {}),
    ...(generationId ? { generationId } : {}),
    ...(routing ? { routing } : {}),
    ...(classification ? { classification } : {}),
    ...(typeof raw.autonomous === "boolean" ? { autonomous: raw.autonomous } : {}),
    ...(turnSeq !== null ? { turnSeq } : {}),
  };
}

function sanitizeInputReceipt(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const inputId = cleanInputId(raw.inputId);
  const clientRequestId = cleanInputId(raw.clientRequestId);
  const acceptedAt = cleanIso(raw.acceptedAt);
  const settledAt = cleanIso(raw.settledAt);
  const state = typeof raw.state === "string" && INPUT_TERMINAL_STATES.has(raw.state) ? raw.state : null;
  if (!inputId || !clientRequestId || !acceptedAt || !settledAt || !state) return null;
  const generationId = cleanInputId(raw.generationId);
  const reason = cleanString(raw.reason, TEXT_CLIP);
  return {
    inputId,
    clientRequestId,
    state,
    acceptedAt,
    settledAt,
    ...(generationId ? { generationId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizedPendingInputs(raw) {
  const out = [];
  const inputIds = new Set();
  const requestIds = new Set();
  let bytes = 0;
  for (const candidate of Array.isArray(raw) ? raw : []) {
    const input = sanitizePendingInput(candidate);
    if (!input || inputIds.has(input.inputId) || requestIds.has(input.clientRequestId)) continue;
    const inputBytes = Buffer.byteLength(input.message, "utf8");
    if (bytes + inputBytes > INPUT_QUEUE_BYTES_CAP) break;
    inputIds.add(input.inputId);
    requestIds.add(input.clientRequestId);
    out.push(input);
    bytes += inputBytes;
    if (out.length >= INPUT_QUEUE_CAP) break;
  }
  return out;
}

function normalizedInputReceipts(raw) {
  const out = [];
  const inputIds = new Set();
  const requestIds = new Set();
  for (const candidate of Array.isArray(raw) ? raw : []) {
    const receipt = sanitizeInputReceipt(candidate);
    if (!receipt || inputIds.has(receipt.inputId) || requestIds.has(receipt.clientRequestId)) continue;
    inputIds.add(receipt.inputId);
    requestIds.add(receipt.clientRequestId);
    out.push(receipt);
  }
  return out.slice(-INPUT_RECEIPT_CAP);
}

function cleanSessionLabel(raw, max = SESSION_LABEL_CAP) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= max ? value : null;
}

function capSessionText(raw) {
  if (typeof raw !== "string") return null;
  if (raw.length <= SESSION_TEXT_CAP) return raw;
  // Persisted events are sanitized again on every GET. Recognize our own marker so
  // the cap is idempotent instead of repeatedly truncating the marker and inflating
  // the reported omitted count on each reload.
  if (/^\n… \[truncated \d+ chars\]$/.test(raw.slice(SESSION_TEXT_CAP))) return raw;
  return `${raw.slice(0, SESSION_TEXT_CAP)}\n… [truncated ${raw.length - SESSION_TEXT_CAP} chars]`;
}

function cleanFiniteNumber(raw, { integer = false, min = -Infinity } = {}) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min) return null;
  if (integer && !Number.isInteger(raw)) return null;
  return raw;
}

function cleanOptionalId(raw, present) {
  if (!present) return undefined;
  if (raw === null) return null;
  return cleanSessionId(raw) ?? INVALID_SESSION_VALUE;
}

// Permission suggestions are SDK-owned JSON objects. Preserve their JSON value
// shape without retaining prototypes/non-finite numbers; long strings get the same
// honest cap as other durable human-readable payloads.
function sanitizeSessionJson(raw, depth = 0) {
  if (depth > 8) return INVALID_SESSION_VALUE;
  if (raw === null || typeof raw === "boolean") return raw;
  if (typeof raw === "string") return capSessionText(raw);
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : INVALID_SESSION_VALUE;
  if (Array.isArray(raw)) {
    const out = [];
    for (const value of raw) {
      const clean = sanitizeSessionJson(value, depth + 1);
      if (clean === INVALID_SESSION_VALUE) return INVALID_SESSION_VALUE;
      out.push(clean);
    }
    return out;
  }
  if (!raw || typeof raw !== "object") return INVALID_SESSION_VALUE;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (DANGEROUS_KEYS.has(key) || key.length > 200) continue;
    const clean = sanitizeSessionJson(value, depth + 1);
    if (clean === INVALID_SESSION_VALUE) return INVALID_SESSION_VALUE;
    out[key] = clean;
  }
  return out;
}

function sanitizeResultImages(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const images = [];
  for (const image of raw) {
    if (!image || typeof image !== "object" || Array.isArray(image)) return null;
    const mediaType = cleanSessionLabel(image.mediaType, 200);
    // Do not trim, decode, or re-encode data. Even a single-character mutation can
    // make an otherwise valid screenshot undecodable.
    if (!mediaType || typeof image.data !== "string") return null;
    images.push({ mediaType, data: image.data });
  }
  return images;
}

function copyOptionalText(out, raw, key) {
  if (!Object.hasOwn(raw, key)) return true;
  const value = capSessionText(raw[key]);
  if (value === null) return false;
  out[key] = value;
  return true;
}

function copyOptionalLabel(out, raw, key, max = SESSION_LABEL_CAP) {
  if (!Object.hasOwn(raw, key)) return true;
  const value = cleanSessionLabel(raw[key], max);
  if (!value) return false;
  out[key] = value;
  return true;
}

function copyOptionalNumber(out, raw, key, opts) {
  if (!Object.hasOwn(raw, key)) return true;
  const value = cleanFiniteNumber(raw[key], opts);
  if (value === null) return false;
  out[key] = value;
  return true;
}

/** Whitelist one canonical transcript/extension block for durable storage. */
export function sanitizeSessionBlock(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = cleanSessionLabel(raw.type, 80);
  if (!type || !SESSION_BLOCK_TYPES.has(type)) return null;

  if (type === "text" || type === "thinking") {
    const text = capSessionText(raw.text);
    return text === null ? null : { type, text };
  }

  if (type === "tool_use") {
    const toolUseId = cleanOptionalId(raw.toolUseId, Object.hasOwn(raw, "toolUseId"));
    const name = cleanSessionLabel(raw.name, 200);
    const input = capSessionText(raw.input);
    if (toolUseId === INVALID_SESSION_VALUE || !name || input === null) return null;
    return {
      type,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      name,
      input,
    };
  }

  if (type === "tool_result") {
    const toolUseId = cleanOptionalId(raw.toolUseId, Object.hasOwn(raw, "toolUseId"));
    const text = capSessionText(raw.text);
    const images = sanitizeResultImages(raw.images);
    if (toolUseId === INVALID_SESSION_VALUE || text === null || images === null) return null;
    if (Object.hasOwn(raw, "isError") && typeof raw.isError !== "boolean") return null;
    return {
      type,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(Object.hasOwn(raw, "isError") ? { isError: raw.isError } : {}),
      text,
      images,
    };
  }

  if (type === "tool_progress") {
    const toolUseId = cleanOptionalId(raw.toolUseId, Object.hasOwn(raw, "toolUseId"));
    const text = capSessionText(raw.text);
    if (toolUseId === INVALID_SESSION_VALUE || text === null) return null;
    const out = { type, ...(toolUseId !== undefined ? { toolUseId } : {}), text };
    if (!copyOptionalLabel(out, raw, "name", 200)) return null;
    if (!copyOptionalNumber(out, raw, "elapsedMs", { min: 0 })) return null;
    if (!copyOptionalNumber(out, raw, "timeoutMs", { min: 0 })) return null;
    if (!copyOptionalNumber(out, raw, "totalBytes", { integer: true, min: 0 })) return null;
    if (!copyOptionalNumber(out, raw, "totalLines", { integer: true, min: 0 })) return null;
    if (!copyOptionalLabel(out, raw, "status", 200)) return null;
    if (!copyOptionalLabel(out, raw, "taskId")) return null;
    return out;
  }

  if (type === "related_task") {
    const toolUseId = cleanOptionalId(raw.toolUseId, Object.hasOwn(raw, "toolUseId"));
    if (toolUseId === INVALID_SESSION_VALUE) return null;
    const out = { type, ...(toolUseId !== undefined ? { toolUseId } : {}) };
    if (!copyOptionalLabel(out, raw, "taskId")) return null;
    if (!copyOptionalLabel(out, raw, "name", 200)) return null;
    if (!copyOptionalText(out, raw, "detail")) return null;
    if (!copyOptionalLabel(out, raw, "status", 200)) return null;
    if (!copyOptionalText(out, raw, "text")) return null;
    if (!copyOptionalLabel(out, raw, "streamUrl", 2_000)) return null;
    return out;
  }

  if (type === "status") {
    const status = cleanSessionLabel(raw.status, 200);
    const text = capSessionText(raw.text);
    if (!status || text === null) return null;
    const out = { type, status, text };
    if (!copyOptionalLabel(out, raw, "subtype", 200)) return null;
    return out;
  }

  if (type === "error") {
    const kind = cleanSessionLabel(raw.kind, 200);
    const text = capSessionText(raw.text);
    return !kind || text === null ? null : { type, kind, text };
  }

  if (type === "rate_limit") {
    const status = cleanSessionLabel(raw.status, 200);
    if (!status) return null;
    const out = { type, status };
    if (!copyOptionalLabel(out, raw, "rateLimitType", 200)) return null;
    if (!copyOptionalNumber(out, raw, "resetsAt")) return null;
    if (!copyOptionalNumber(out, raw, "utilization")) return null;
    if (!copyOptionalLabel(out, raw, "overageStatus", 200)) return null;
    if (!copyOptionalNumber(out, raw, "overageResetsAt")) return null;
    if (Object.hasOwn(raw, "isUsingOverage")) {
      if (typeof raw.isUsingOverage !== "boolean") return null;
      out.isUsingOverage = raw.isUsingOverage;
    }
    return out;
  }

  if (type === "turn_end") {
    if (!new Set(["completed", "error", "cancelled"]).has(raw.status)) return null;
    const out = { type, status: raw.status };
    if (!copyOptionalLabel(out, raw, "subtype", 200)) return null;
    if (Object.hasOwn(raw, "stopReason")) {
      if (raw.stopReason === null) out.stopReason = null;
      else if (!copyOptionalText(out, raw, "stopReason")) return null;
    }
    if (!copyOptionalText(out, raw, "result")) return null;
    if (Object.hasOwn(raw, "errors")) {
      if (!Array.isArray(raw.errors)) return null;
      const errors = [];
      for (const error of raw.errors) {
        const text = capSessionText(error);
        if (text === null) return null;
        errors.push(text);
      }
      out.errors = errors;
    }
    return out;
  }

  // Permission prompts are an extension seam rather than an SDK object dump. Keep
  // the stable coordinates and presentation fields explicit; suggestions may be a
  // nested PermissionUpdate list, sanitized recursively without changing its JSON
  // shape. Revisions can update status/decision fields without moving the event.
  const requestId = cleanSessionId(raw.requestId);
  const generationId = cleanSessionId(raw.generationId);
  const name = cleanSessionLabel(raw.name, 200);
  const status = PERMISSION_STATUSES.has(raw.status) ? raw.status : null;
  const inputComplete = typeof raw.inputComplete === "boolean" ? raw.inputComplete : null;
  const suggestionsComplete = typeof raw.suggestionsComplete === "boolean" ? raw.suggestionsComplete : null;
  if (!requestId || !generationId || !name || !status || inputComplete === null || suggestionsComplete === null || !Object.hasOwn(raw, "input")) return null;
  const input = typeof raw.input === "string" ? capSessionText(raw.input) : sanitizeSessionJson(raw.input);
  if (input === null || input === INVALID_SESSION_VALUE) return null;
  if (inputComplete && JSON.stringify(input) !== JSON.stringify(raw.input)) return null;
  const toolUseId = cleanOptionalId(raw.toolUseId, Object.hasOwn(raw, "toolUseId"));
  if (toolUseId === INVALID_SESSION_VALUE) return null;
  const hasDecision = Object.hasOwn(raw, "decision");
  const decision = hasDecision && PERMISSION_DECISIONS.has(raw.decision) ? raw.decision : null;
  if (hasDecision && !decision) return null;
  // A resolved prompt is actionable history only with its exact decision. Pending
  // and cancelled prompts must not carry a stale answer from an earlier revision.
  if ((status === "resolved") !== Boolean(decision)) return null;
  const out = {
    type,
    requestId,
    generationId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    name,
    input,
    inputComplete,
    suggestionsComplete,
    status,
    ...(decision ? { decision } : {}),
  };
  if (!copyOptionalText(out, raw, "title")) return null;
  if (!copyOptionalLabel(out, raw, "displayName", 200)) return null;
  if (!copyOptionalText(out, raw, "description")) return null;
  if (!copyOptionalLabel(out, raw, "blockedPath", 2_000)) return null;
  if (!copyOptionalLabel(out, raw, "agentId")) return null;
  if (!copyOptionalText(out, raw, "reason")) return null;
  if (Object.hasOwn(raw, "suggestions")) {
    if (!Array.isArray(raw.suggestions)) return null;
    // A complete disclosure must fit the same bound enforced by the producer;
    // otherwise reject the event instead of persisting a deceptively partial
    // approval surface. Incomplete diagnostics may retain a bounded preview,
    // but their false flag keeps every persistent approval path disabled.
    if (suggestionsComplete && raw.suggestions.length > PERMISSION_SUGGESTION_CAP) return null;
    const suggestions = sanitizeSessionJson(
      suggestionsComplete ? raw.suggestions : raw.suggestions.slice(0, PERMISSION_SUGGESTION_CAP)
    );
    if (suggestions === INVALID_SESSION_VALUE || !Array.isArray(suggestions)) return null;
    if (suggestionsComplete && JSON.stringify(suggestions) !== JSON.stringify(raw.suggestions)) return null;
    out.suggestions = suggestions;
  }
  if (decision === "allow_once" && !inputComplete) return null;
  if (
    decision === "allow_always" &&
    (!inputComplete || !suggestionsComplete || !Array.isArray(out.suggestions) || out.suggestions.length === 0)
  ) return null;
  return out;
}

/** Sanitize one gateway `session_event` envelope. Malformed input is refused as a
 * whole: dropping a bad block would create a deceptively complete transcript. */
export function sanitizeSessionEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = cleanSessionId(raw.id);
  const role = raw.role === "user" || raw.role === "assistant" ? raw.role : null;
  const ts = cleanFiniteNumber(raw.ts);
  const order = cleanFiniteNumber(raw.order, { integer: true, min: 0 });
  const revision = cleanFiniteNumber(raw.revision, { integer: true, min: 0 });
  if (!id || !role || ts === null || order === null || revision === null || !Array.isArray(raw.blocks) || raw.blocks.length === 0) {
    return null;
  }
  const turnId = cleanOptionalId(raw.turnId, Object.hasOwn(raw, "turnId"));
  const sessionId = cleanOptionalId(raw.sessionId, Object.hasOwn(raw, "sessionId"));
  const generationId = cleanOptionalId(raw.generationId, Object.hasOwn(raw, "generationId"));
  if (
    turnId === INVALID_SESSION_VALUE || turnId === null ||
    sessionId === INVALID_SESSION_VALUE || sessionId === null ||
    generationId === INVALID_SESSION_VALUE || generationId === null
  ) return null;
  if (Object.hasOwn(raw, "toolResultsOnly") && typeof raw.toolResultsOnly !== "boolean") return null;
  const blocks = [];
  for (const block of raw.blocks) {
    const clean = sanitizeSessionBlock(block);
    if (!clean) return null;
    blocks.push(clean);
  }
  return {
    id,
    role,
    ts,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(generationId !== undefined ? { generationId } : {}),
    order,
    revision,
    ...(Object.hasOwn(raw, "toolResultsOnly") ? { toolResultsOnly: raw.toolResultsOnly } : {}),
    blocks,
  };
}

/** Stable-id, latest-revision merge. A revision replaces the original array slot;
 * arrival order of unrelated events is never changed. Invalid events are ignored. */
export function mergeSessionEvents(existing, incoming) {
  const out = [];
  const indexById = new Map();
  const upsert = (raw) => {
    const event = sanitizeSessionEvent(raw);
    if (!event) return;
    const index = indexById.get(event.id);
    if (index === undefined) {
      indexById.set(event.id, out.length);
      out.push(event);
    } else if (event.revision > out[index].revision) {
      out[index] = event;
    }
  };
  for (const event of Array.isArray(existing) ? existing : []) upsert(event);
  for (const event of Array.isArray(incoming) ? incoming : incoming ? [incoming] : []) upsert(event);
  return out;
}

function normalizedSessionIds(raw, events, latest) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const id = cleanSessionId(value);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of Array.isArray(raw) ? raw : []) add(id);
  for (const event of Array.isArray(events) ? events : []) add(event?.sessionId);
  add(latest);
  return out;
}

function recordThreadSession(thread, rawSessionId) {
  const sessionId = cleanSessionId(rawSessionId);
  if (!sessionId) return false;
  const beforeIds = normalizedSessionIds(thread.sessionIds, thread.sessionEvents, thread.claudeSessionId);
  const nextIds = beforeIds.includes(sessionId) ? beforeIds : [...beforeIds, sessionId];
  const changed = JSON.stringify(thread.sessionIds ?? []) !== JSON.stringify(nextIds) || thread.claudeSessionId !== sessionId;
  thread.sessionIds = nextIds;
  thread.claudeSessionId = sessionId;
  return changed;
}

function deriveTitle(thread) {
  if (thread.title && String(thread.title).trim()) return String(thread.title).trim();
  const firstUser = (thread.messages ?? []).find((m) => m.role === "user" && m.text?.trim());
  if (firstUser) {
    const firstLine = firstUser.text.split("\n").map((l) => l.trim()).find(Boolean) ?? firstUser.text;
    return firstLine.replace(/^#+\s*/, "").slice(0, 60).trim() || "New conversation";
  }
  return "New conversation";
}

function toMeta(thread) {
  const pendingInputs = normalizedPendingInputs(thread.pendingInputs);
  return {
    id: thread.id,
    title: deriveTitle(thread),
    source: thread.source ?? "chat",
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? thread.createdAt ?? null,
    messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
    pendingInputCount: pendingInputs.length,
    inputRevision: cleanInt(thread.inputRevision, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    // The pinned run context travels with the meta so the thread list / rail can
    // show a pin without a second full-thread read.
    routing: thread.routing ?? null,
  };
}

async function readThreadFile(id) {
  try {
    const raw = await readFile(threadPath(id), "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    obj.id = id; // pin to the on-disk filename, never a tampered inner id
    if (!Array.isArray(obj.messages)) obj.messages = [];
    // Canonical events are always rebuilt through the sanitizer on read. This also
    // heals duplicate ids in a hand-edited/legacy file with the same latest-revision,
    // original-position rule used by live appends.
    obj.sessionEvents = mergeSessionEvents(obj.sessionEvents, []);
    const latestSessionId = cleanSessionId(obj.claudeSessionId);
    if (latestSessionId) obj.claudeSessionId = latestSessionId;
    else delete obj.claudeSessionId;
    obj.sessionIds = normalizedSessionIds(obj.sessionIds, obj.sessionEvents, latestSessionId);
    obj.pendingInputs = normalizedPendingInputs(obj.pendingInputs);
    obj.inputReceipts = normalizedInputReceipts(obj.inputReceipts);
    obj.inputRevision = cleanInt(obj.inputRevision, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    // Legacy files (every thread written before the run-context contract) have no
    // `routing` key at all; normalise to an explicit null so every reader can treat
    // "no pin" uniformly. Re-sanitising also means a hand-edited file cannot inject
    // fields the write path would have refused. Per-message route/overrides are NOT
    // re-walked here - they were whitelisted on the way in and a transcript can be
    // long.
    obj.routing = sanitizeRouting(obj.routing);
    return obj;
  } catch {
    return null;
  }
}

/** List all threads as lightweight metadata, newest activity first. */
export async function listThreads() {
  let names = [];
  try {
    names = (await readdir(THREADS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const metas = [];
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    const thread = await readThreadFile(id);
    if (thread) metas.push(toMeta(thread));
  }
  metas.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return metas;
}

/** Full thread (with messages) or null. */
export async function getThread(id) {
  const safe = safeThreadId(id);
  if (!safe) return null;
  return readThreadFile(safe);
}

/** Read the transcript and its public input lifecycle from one immutable file
 * snapshot. HTTP hydration must not combine a pre-settlement message list with a
 * post-settlement queue read (or the inverse), because that can make a completed
 * turn look like an unanswered idle user message until another refresh. */
export async function getThreadSnapshot(id) {
  const thread = await getThread(id);
  if (!thread) return null;
  const pending = normalizedPendingInputs(thread.pendingInputs);
  return {
    thread,
    pendingInputs: pending.map((input) => publicThreadInput(input, pending)),
    inputRevision: cleanInt(thread.inputRevision, 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}

/**
 * Ensure a thread exists for the given (opaque) id, creating it if absent.
 * Idempotent: re-opening the same key returns the existing thread. A provided
 * title backfills an untitled thread but never overwrites a real one.
 * @returns {Promise<object>} the full thread.
 */
export async function ensureThread({ id, title, source, mode, context, nowIso }) {
  const safe = id ? safeThreadId(id) : newThreadId();
  return serializeThreadMutation(safe, async () => {
    const existing = await readThreadFile(safe);
    const now = nowIso ?? new Date().toISOString();
    if (existing) {
      let changed = false;
      if (title && !existing.title) { existing.title = String(title).slice(0, 120); changed = true; }
      // "chat" is the DEFAULT this function stamps on any thread created without a
      // declared source, so it means "nobody said" rather than "the user chose
      // chat". A host that later opens the same thread as a Discuss must be able to
      // fill it in — otherwise whichever code path happened to touch the thread
      // first wins, the transcript never hides the kickoff bubble, and the Discuss
      // duty pin is never applied. Any other existing source is a real declaration
      // and is left alone.
      if (source && String(source) !== "chat" && (!existing.source || existing.source === "chat")) {
        existing.source = String(source);
        changed = true;
      }
      if (mode && !existing.mode) { existing.mode = String(mode); changed = true; }
      if (context !== undefined && existing.context === undefined) { existing.context = context; changed = true; }
      if (changed) { existing.updatedAt = now; await atomicWriteJson(threadPath(safe), existing); }
      return existing;
    }
    const thread = {
      id: safe,
      title: title ? String(title).slice(0, 120) : "",
      source: source ? String(source) : "chat",
      mode: mode ? String(mode) : null,
      context: context ?? undefined,
      routing: null, // set later via setThreadRouting; never seeded from open params
      createdAt: now,
      updatedAt: now,
      messages: [],
      sessionEvents: [],
      sessionIds: [],
      pendingInputs: [],
      inputReceipts: [],
      inputRevision: 0,
    };
    await atomicWriteJson(threadPath(safe), thread);
    return thread;
  });
}

/**
 * Record the Claude session id the gateway reported for this thread's turn, so
 * the rich-transcript endpoint can find the on-disk JSONL. Idempotent and
 * best-effort: a thread that doesn't exist yet, or an unchanged id, is a no-op.
 */
export async function setThreadSession(id, sessionId) {
  const safe = safeThreadId(id);
  if (!safe || !cleanSessionId(sessionId)) return null;
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    if (!recordThreadSession(thread, sessionId)) return toMeta(thread);
    await atomicWriteJson(threadPath(safe), thread);
    return toMeta(thread);
  });
}

/** Persist one canonical session event. A higher revision replaces the stable id's
 * original slot; stale/equal revisions are no-ops. The event's session coordinate
 * joins the same atomic write, so GET never exposes an event without its session
 * appearing in the append-only chain. Returns the stored event, or null on refusal. */
export async function appendSessionEvent(id, event, { nowIso } = {}) {
  const safe = safeThreadId(id);
  const clean = sanitizeSessionEvent(event);
  if (!safe || !clean) return null;
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    const current = Array.isArray(thread.sessionEvents) ? thread.sessionEvents : [];
    const index = current.findIndex((candidate) => candidate.id === clean.id);
    // Stable-id revision rejection is a TOTAL no-op. In particular, a stale
    // payload's session coordinate must not move the thread's latest-session
    // pointer away from the newer event that remains stored.
    if (index !== -1 && clean.revision <= current[index].revision) return current[index];
    if (index === -1) {
      thread.sessionEvents = [...current, clean];
    } else {
      thread.sessionEvents = current.slice();
      thread.sessionEvents[index] = clean;
    }
    if (clean.sessionId) recordThreadSession(thread, clean.sessionId);
    thread.updatedAt = nowIso ?? new Date().toISOString();
    await atomicWriteJson(threadPath(safe), thread);
    return clean;
  });
}

/**
 * Pin (or clear) this thread's run context - the sparse TurnRouting the user set
 * from the turn rail, effective from the next message and persisted server-side so
 * it follows them across devices (contract §13).
 *
 * Deliberately NOT ensureThread's write-once-if-absent shape: a pin exists to be
 * changed, so it is last-write-wins. Single-user app, no concurrent editor to
 * arbitrate against. Passing null / {} / an all-junk object CLEARS the pin.
 *
 * @returns {Promise<object|null>} the stored routing, or null when cleared or when
 *   the thread does not exist (open it first; a pin never conjures a thread).
 */
export async function setThreadRouting(id, routing, { nowIso } = {}) {
  const safe = safeThreadId(id);
  if (!safe) return null;
  const next = sanitizeRouting(routing);
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    // The client re-asserts the current pin on every poll; only write when the pin
    // actually changed, so an idle thread is not rewritten (and re-sorted) every 10s.
    if (JSON.stringify(thread.routing ?? null) === JSON.stringify(next ?? null)) return next;
    thread.routing = next;
    thread.updatedAt = nowIso ?? new Date().toISOString();
    await atomicWriteJson(threadPath(safe), thread);
    return next;
  });
}

/**
 * Append completed exchanges to a thread (creating it if needed). `messages` is a
 * list of { role: 'user'|'assistant', text } plus, optionally, the run context of
 * that turn: `route` (the resolved RunAttribution) on an assistant message and
 * `overrides` (the pins in force) on a user message. Stamps each with a timestamp
 * and bumps updatedAt. Returns the updated thread meta.
 */
export async function appendMessages(id, messages, { nowIso, idempotencyKey = null } = {}) {
  const safe = safeThreadId(id);
  if (!safe) throw new Error("appendMessages: invalid thread id");
  const now = nowIso ?? new Date().toISOString();
  const deliveryKey = cleanString(idempotencyKey, 200);
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .map((m) => {
      // Still rebuilt from scratch rather than spread: only these keys reach disk.
      // `ts` is caller-supplied, so clip it too instead of storing whatever JSON
      // value arrived.
      const out = { role: m.role, text: m.text, ts: cleanString(m.ts, ID_CLIP) ?? now };
      const turnId = cleanString(m.turnId, ID_CLIP);
      const sessionId = cleanString(m.sessionId, ID_CLIP);
      if (turnId) out.turnId = turnId;
      if (sessionId) out.sessionId = sessionId;
      if (m.role === "assistant") {
        // What actually RAN, incl. the routed runtime's own sessionId/transcriptPath.
        // Persisted per message because the thread-level claudeSessionId is
        // last-write-wins and so cannot describe an older turn (contract §12), and
        // because the 10s thread poll remounts the chat and would otherwise wipe the
        // in-memory badges (§10).
        const route = sanitizeRouteMeta(m.route);
        if (route) out.route = route;
      } else {
        // The pinned INTENT that was in force when this message was sent, kept apart
        // from the resolved result so a rejected override stays visible as a pin.
        const overrides = sanitizeRouting(m.overrides);
        if (overrides) out.overrides = overrides;
      }
      return out;
    });
  return serializeThreadMutation(safe, async () => {
    let thread = await readThreadFile(safe);
    if (!thread) {
      thread = {
        id: safe,
        title: "",
        source: "chat",
        mode: null,
        routing: null,
        createdAt: now,
        updatedAt: now,
        messages: [],
        sessionEvents: [],
        sessionIds: [],
        pendingInputs: [],
        inputReceipts: [],
        inputRevision: 0,
      };
    }
    if (deliveryKey && Array.isArray(thread.messageKeys) && thread.messageKeys.includes(deliveryKey)) {
      return toMeta(thread);
    }
    if (!clean.length) return toMeta(thread);
    thread.messages.push(...clean);
    if (deliveryKey) thread.messageKeys = [...(Array.isArray(thread.messageKeys) ? thread.messageKeys : []), deliveryKey].slice(-512);
    thread.updatedAt = now;
    if (!thread.title) thread.title = deriveTitle(thread);
    await atomicWriteJson(threadPath(safe), thread);
    return toMeta(thread);
  });
}

function inputPosition(pendingInputs, inputId) {
  const queued = pendingInputs.filter((input) => input.state === "queued");
  const index = queued.findIndex((input) => input.inputId === inputId);
  return index === -1 ? undefined : index + 1;
}

function publicThreadInput(input, pendingInputs = []) {
  if (!input) return null;
  const position = inputPosition(pendingInputs, input.inputId);
  return {
    inputId: input.inputId,
    clientRequestId: input.clientRequestId,
    state: input.state,
    acceptedAt: input.acceptedAt,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.generationId ? { generationId: input.generationId } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.routing ? { routing: input.routing } : {}),
    ...(input.classification ? { classification: input.classification } : {}),
    ...(typeof input.autonomous === "boolean" ? { autonomous: input.autonomous } : {}),
    ...(Number.isInteger(input.turnSeq) ? { turnSeq: input.turnSeq } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(input.settledAt ? { settledAt: input.settledAt } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function bumpInputRevision(thread) {
  const current = cleanInt(thread.inputRevision, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  thread.inputRevision = current >= Number.MAX_SAFE_INTEGER ? current : current + 1;
}

/** Admit one browser input into the durable per-thread FIFO. The caller supplies
 * a stable clientRequestId so a lost 202 response can be retried without creating
 * a second operative turn. Routing is already the server-resolved admission
 * snapshot; later rail edits cannot reorder or retarget queued work. */
export async function admitThreadInput(id, raw, { nowIso, inputId: requestedInputId } = {}) {
  const safe = safeThreadId(id);
  if (!safe) throw new Error("admitThreadInput: invalid thread id");
  const message = typeof raw?.message === "string" && raw.message.trim() && raw.message.length <= INPUT_MESSAGE_CAP
    ? raw.message
    : null;
  const clientRequestId = cleanInputId(raw?.clientRequestId);
  if (message === null) throw new Error("message is required");
  if (!clientRequestId) throw new Error("valid clientRequestId is required");
  const now = nowIso ?? new Date().toISOString();
  const inputId = cleanInputId(requestedInputId) ?? randomUUID();
  const routing = sanitizeRouting(raw?.routing);
  const classification = sanitizeClassification(raw?.classification);
  const turnSeq = cleanInt(raw?.turnSeq, 0, Number.MAX_SAFE_INTEGER);
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    const pending = normalizedPendingInputs(thread.pendingInputs);
    const receipts = normalizedInputReceipts(thread.inputReceipts);
    const duplicate = pending.find((input) => input.clientRequestId === clientRequestId)
      ?? receipts.find((input) => input.clientRequestId === clientRequestId);
    if (duplicate) return { input: publicThreadInput(duplicate, pending), duplicate: true };
    const queuedBytes = pending.reduce((total, input) => total + Buffer.byteLength(input.message, "utf8"), 0);
    if (pending.length >= INPUT_QUEUE_CAP || queuedBytes + Buffer.byteLength(message, "utf8") > INPUT_QUEUE_BYTES_CAP) {
      const error = new Error(`thread input queue is full (${INPUT_QUEUE_CAP} inputs / 2 MiB)`);
      error.code = "QUEUE_FULL";
      throw error;
    }
    const input = {
      inputId,
      clientRequestId,
      message,
      state: "queued",
      acceptedAt: now,
      ...(routing ? { routing } : {}),
      ...(classification ? { classification } : {}),
      ...(typeof raw?.autonomous === "boolean" ? { autonomous: raw.autonomous } : {}),
      ...(turnSeq !== null ? { turnSeq } : {}),
    };
    thread.pendingInputs = [...pending, input];
    thread.inputReceipts = receipts;
    bumpInputRevision(thread);
    thread.updatedAt = now;
    await atomicWriteJson(threadPath(safe), thread);
    return { input: publicThreadInput(input, thread.pendingInputs), duplicate: false };
  });
}

/** Pending inputs in durable FIFO order. Full text is returned because the owning
 * thread UI needs to reconstruct queued user bubbles after a reload. */
export async function listThreadInputs(id) {
  const thread = await getThread(id);
  if (!thread) return null;
  const pending = normalizedPendingInputs(thread.pendingInputs);
  return pending.map((input) => publicThreadInput(input, pending));
}

/** Atomically promote the oldest queued input when the thread has no active one.
 * The user message is written in the same mutation and keyed by inputId, so a
 * promoted turn can never be invisible in durable history. */
export async function claimNextThreadInput(id, { nowIso } = {}) {
  const safe = safeThreadId(id);
  if (!safe) return null;
  const now = nowIso ?? new Date().toISOString();
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    const pending = normalizedPendingInputs(thread.pendingInputs);
    if (pending.some((input) => input.state !== "queued")) return null;
    const index = pending.findIndex((input) => input.state === "queued");
    if (index === -1) return null;
    const input = { ...pending[index], state: "starting", startedAt: now };
    pending[index] = input;
    thread.pendingInputs = pending;
    const messageKey = `input:${input.inputId}`;
    const keys = Array.isArray(thread.messageKeys) ? thread.messageKeys : [];
    if (!keys.includes(messageKey)) {
      thread.messages.push({
        role: "user",
        text: input.message,
        ts: input.acceptedAt,
        turnId: input.inputId,
        ...(input.routing ? { overrides: input.routing } : {}),
      });
      thread.messageKeys = [...keys, messageKey].slice(-512);
      if (!thread.title) thread.title = deriveTitle(thread);
    }
    bumpInputRevision(thread);
    thread.updatedAt = now;
    await atomicWriteJson(threadPath(safe), thread);
    return publicThreadInput(input, pending);
  });
}

/** Bind the gateway-owned generation only after its `open` frame. */
export async function bindThreadInputGeneration(id, inputId, generationId, { nowIso } = {}) {
  const safe = safeThreadId(id);
  const cleanInput = cleanInputId(inputId);
  const cleanGeneration = cleanInputId(generationId);
  if (!safe || !cleanInput || !cleanGeneration) return null;
  const now = nowIso ?? new Date().toISOString();
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    const pending = normalizedPendingInputs(thread.pendingInputs);
    const index = pending.findIndex((input) => input.inputId === cleanInput);
    if (index === -1) return null;
    const current = pending[index];
    if (current.state === "running" && current.generationId === cleanGeneration) {
      return publicThreadInput(current, pending);
    }
    if (current.state !== "starting" || (current.generationId && current.generationId !== cleanGeneration)) return null;
    pending[index] = { ...current, state: "running", generationId: cleanGeneration };
    thread.pendingInputs = pending;
    bumpInputRevision(thread);
    thread.updatedAt = now;
    await atomicWriteJson(threadPath(safe), thread);
    return publicThreadInput(pending[index], pending);
  });
}

export async function markThreadInputStopping(id, inputId, generationId, { nowIso } = {}) {
  const safe = safeThreadId(id);
  const cleanInput = cleanInputId(inputId);
  const cleanGeneration = cleanInputId(generationId);
  if (!safe || !cleanInput || !cleanGeneration) return null;
  const now = nowIso ?? new Date().toISOString();
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    const pending = normalizedPendingInputs(thread.pendingInputs);
    const index = pending.findIndex((input) => input.inputId === cleanInput);
    if (index === -1) return null;
    const current = pending[index];
    if (!((current.state === "running" || current.state === "stopping") && current.generationId === cleanGeneration)) return null;
    if (current.state === "stopping") return publicThreadInput(current, pending);
    pending[index] = { ...current, state: "stopping" };
    thread.pendingInputs = pending;
    bumpInputRevision(thread);
    thread.updatedAt = now;
    await atomicWriteJson(threadPath(safe), thread);
    return publicThreadInput(pending[index], pending);
  });
}

/** Remove a completed active input from the queue while retaining a bounded
 * idempotency receipt. A stale producer cannot settle a newer turn because both
 * the Web input id and (when assigned) gateway generation must match. */
export async function settleThreadInput(id, inputId, outcome, { generationId, reason, nowIso } = {}) {
  const safe = safeThreadId(id);
  const cleanInput = cleanInputId(inputId);
  const state = INPUT_TERMINAL_STATES.has(outcome) ? outcome : null;
  const cleanGeneration = generationId === undefined ? null : cleanInputId(generationId);
  if (!safe || !cleanInput || !state || (generationId !== undefined && !cleanGeneration)) return null;
  const now = nowIso ?? new Date().toISOString();
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (!thread) return null;
    const pending = normalizedPendingInputs(thread.pendingInputs);
    const index = pending.findIndex((input) => input.inputId === cleanInput);
    if (index === -1) {
      const prior = normalizedInputReceipts(thread.inputReceipts).find((input) => input.inputId === cleanInput);
      return prior ? publicThreadInput(prior, pending) : null;
    }
    const current = pending[index];
    if (cleanGeneration && current.generationId && current.generationId !== cleanGeneration) return null;
    const receipt = sanitizeInputReceipt({
      inputId: current.inputId,
      clientRequestId: current.clientRequestId,
      state,
      acceptedAt: current.acceptedAt,
      settledAt: now,
      generationId: current.generationId ?? cleanGeneration ?? undefined,
      reason,
    });
    if (!receipt) return null;
    pending.splice(index, 1);
    const receipts = normalizedInputReceipts(thread.inputReceipts)
      .filter((candidate) => candidate.inputId !== receipt.inputId && candidate.clientRequestId !== receipt.clientRequestId);
    thread.pendingInputs = pending;
    thread.inputReceipts = [...receipts, receipt].slice(-INPUT_RECEIPT_CAP);
    bumpInputRevision(thread);
    thread.updatedAt = now;
    await atomicWriteJson(threadPath(safe), thread);
    return publicThreadInput(receipt, pending);
  });
}

export async function getThreadInput(id, inputId) {
  const cleanInput = cleanInputId(inputId);
  const thread = cleanInput ? await getThread(id) : null;
  if (!thread) return null;
  const pending = normalizedPendingInputs(thread.pendingInputs);
  const input = pending.find((candidate) => candidate.inputId === cleanInput)
    ?? normalizedInputReceipts(thread.inputReceipts).find((candidate) => candidate.inputId === cleanInput);
  return input ? publicThreadInput(input, pending) : null;
}

export async function threadHasPendingInputs(id) {
  const thread = await getThread(id);
  return Boolean(thread && normalizedPendingInputs(thread.pendingInputs).length);
}

/** Delete a thread. Returns true if a file was removed. */
export async function deleteThread(id) {
  const safe = safeThreadId(id);
  if (!safe) return false;
  return serializeThreadMutation(safe, async () => {
    const thread = await readThreadFile(safe);
    if (thread && normalizedPendingInputs(thread.pendingInputs).length) return false;
    try {
      await unlink(threadPath(safe));
      return true;
    } catch {
      return false;
    }
  });
}

// Synchronous existence probe (used only in tests / quick checks).
export function threadExistsSync(id) {
  const safe = safeThreadId(id);
  return safe ? existsSync(threadPath(safe)) : false;
}

export function _threadsDirForTest() {
  return THREADS_DIR;
}

export function _readThreadSync(id) {
  const safe = safeThreadId(id);
  if (!safe) return null;
  try {
    return JSON.parse(readFileSync(threadPath(safe), "utf8"));
  } catch {
    return null;
  }
}

// ── In-flight turns ──────────────────────────────────────────────────────────
// A turn survives the browser tab: the server proxy keeps streaming and persists
// the exchange on `done`, so closing or navigating away never loses a reply. But
// the CLIENT rebuilds from persisted history on remount, and history has nothing
// in it until the turn settles - so a thread mid-turn looked byte-identical to an
// idle one and the channel read as "stopped working" until the reply landed.
//
// This is deliberately IN-MEMORY, not persisted: it describes live work owned by
// THIS process. A restart has no in-flight turns by definition, and a stale
// on-disk "running" flag would be a lie no one could clear. The generic registry
// retains the ordered SSE prefix as well as the start time so another browser can
// replay and then follow the same turn after navigating back.
const inputStreams = new LiveEventStreamRegistry();
const activeInputByThread = new Map();

export function startInputLive(inputId, at = new Date().toISOString()) {
  const clean = cleanInputId(inputId);
  if (!clean) return null;
  // Admission retries must not supersede followers of the already-owned input.
  if (inputStreams.since(clean)) return { at: inputStreams.since(clean) };
  return inputStreams.start(clean, at);
}

export function markInputActive(threadId, inputId, at = new Date().toISOString()) {
  const thread = safeThreadId(threadId);
  const input = cleanInputId(inputId);
  if (!thread || !input) return false;
  const current = activeInputByThread.get(thread);
  if (current && current.inputId !== input) return false;
  if (!inputStreams.since(input)) inputStreams.start(input, at);
  activeInputByThread.set(thread, { inputId: input, at });
  return true;
}

export function activeInputId(threadId) {
  const thread = safeThreadId(threadId);
  return thread ? activeInputByThread.get(thread)?.inputId ?? null : null;
}

export function appendInputLiveFrame(inputId, frame) {
  const clean = cleanInputId(inputId);
  return clean ? inputStreams.append(clean, frame) : null;
}

export function inputLiveFrames(inputId) {
  const clean = cleanInputId(inputId);
  return clean ? inputStreams.frames(clean) : [];
}

export function subscribeInputLive(inputId, subscriber) {
  const clean = cleanInputId(inputId);
  return clean ? inputStreams.subscribe(clean, subscriber) : null;
}

export function finishInputLive(threadId, inputId, reason = "settled") {
  const thread = safeThreadId(threadId);
  const input = cleanInputId(inputId);
  if (!input) return false;
  if (thread && activeInputByThread.get(thread)?.inputId === input) activeInputByThread.delete(thread);
  return inputStreams.finish(input, reason);
}

// Backward-compatible thread-keyed helpers. New producers always carry inputId;
// these resolve only the exact active input and therefore cannot let an old
// producer append into or settle a newer stream.
export function markRunning(threadId, at = new Date().toISOString()) {
  const legacyInputId = `legacy:${safeThreadId(threadId) ?? "web"}:${randomUUID()}`;
  startInputLive(legacyInputId, at);
  return markInputActive(threadId, legacyInputId, at) ? legacyInputId : null;
}

export function appendLiveFrame(threadId, frame) {
  const inputId = activeInputId(threadId);
  return inputId ? appendInputLiveFrame(inputId, frame) : null;
}

export function liveFrames(threadId) {
  const inputId = activeInputId(threadId);
  return inputId ? inputLiveFrames(inputId) : [];
}

export function subscribeLive(threadId, subscriber) {
  const inputId = activeInputId(threadId);
  return inputId ? subscribeInputLive(inputId, subscriber) : null;
}

export function clearRunning(threadId) {
  const inputId = activeInputId(threadId);
  if (inputId) finishInputLive(threadId, inputId);
}

// ISO timestamp the active input started, or null when the thread is idle. Queued
// inputs do not claim running state; their own receipts carry acceptedAt/position.
export function runningSince(threadId) {
  const thread = safeThreadId(threadId);
  return thread ? activeInputByThread.get(thread)?.at ?? null : null;
}

export function runningThreadIds() {
  return [...activeInputByThread.keys()];
}
