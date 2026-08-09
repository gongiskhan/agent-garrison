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

import { createHash } from "node:crypto";
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
  return {
    id: thread.id,
    title: deriveTitle(thread),
    source: thread.source ?? "chat",
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? thread.createdAt ?? null,
    messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
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

/**
 * Ensure a thread exists for the given (opaque) id, creating it if absent.
 * Idempotent: re-opening the same key returns the existing thread. A provided
 * title backfills an untitled thread but never overwrites a real one.
 * @returns {Promise<object>} the full thread.
 */
export async function ensureThread({ id, title, source, mode, context, nowIso }) {
  const safe = id ? safeThreadId(id) : newThreadId();
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
  };
  await atomicWriteJson(threadPath(safe), thread);
  return thread;
}

/**
 * Record the Claude session id the gateway reported for this thread's turn, so
 * the rich-transcript endpoint can find the on-disk JSONL. Idempotent and
 * best-effort: a thread that doesn't exist yet, or an unchanged id, is a no-op.
 */
export async function setThreadSession(id, sessionId) {
  const safe = safeThreadId(id);
  if (!safe || !sessionId) return;
  const thread = await readThreadFile(safe);
  if (!thread || thread.claudeSessionId === sessionId) return;
  thread.claudeSessionId = sessionId;
  await atomicWriteJson(threadPath(safe), thread);
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
  const thread = await readThreadFile(safe);
  if (!thread) return null;
  const next = sanitizeRouting(routing);
  // The client re-asserts the current pin on every poll; only write when the pin
  // actually changed, so an idle thread is not rewritten (and re-sorted) every 10s.
  if (JSON.stringify(thread.routing ?? null) === JSON.stringify(next ?? null)) return next;
  thread.routing = next;
  thread.updatedAt = nowIso ?? new Date().toISOString();
  await atomicWriteJson(threadPath(safe), thread);
  return next;
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
  let thread = await readThreadFile(safe);
  if (!thread) {
    thread = { id: safe, title: "", source: "chat", mode: null, routing: null, createdAt: now, updatedAt: now, messages: [] };
  }
  const deliveryKey = cleanString(idempotencyKey, 200);
  if (deliveryKey && Array.isArray(thread.messageKeys) && thread.messageKeys.includes(deliveryKey)) {
    return toMeta(thread);
  }
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .map((m) => {
      // Still rebuilt from scratch rather than spread: only these keys reach disk.
      // `ts` is caller-supplied, so clip it too instead of storing whatever JSON
      // value arrived.
      const out = { role: m.role, text: m.text, ts: cleanString(m.ts, ID_CLIP) ?? now };
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
  if (!clean.length) return toMeta(thread);
  thread.messages.push(...clean);
  if (deliveryKey) thread.messageKeys = [...(Array.isArray(thread.messageKeys) ? thread.messageKeys : []), deliveryKey].slice(-512);
  thread.updatedAt = now;
  if (!thread.title) thread.title = deriveTitle(thread);
  await atomicWriteJson(threadPath(safe), thread);
  return toMeta(thread);
}

/** Delete a thread. Returns true if a file was removed. */
export async function deleteThread(id) {
  const safe = safeThreadId(id);
  if (!safe) return false;
  try {
    await unlink(threadPath(safe));
    return true;
  } catch {
    return false;
  }
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
const runningTurns = new LiveEventStreamRegistry();

export function markRunning(threadId, at = new Date().toISOString()) {
  if (!threadId) return null;
  return runningTurns.start(threadId, at);
}

export function appendLiveFrame(threadId, frame) {
  if (!threadId) return null;
  return runningTurns.append(threadId, frame);
}

export function liveFrames(threadId) {
  return threadId ? runningTurns.frames(threadId) : [];
}

export function subscribeLive(threadId, subscriber) {
  return threadId ? runningTurns.subscribe(threadId, subscriber) : null;
}

export function clearRunning(threadId) {
  if (!threadId) return;
  runningTurns.finish(threadId);
}

// ISO timestamp the live turn started, or null when the thread is idle. The
// client renders elapsed time from this, so it survives a reload mid-turn.
export function runningSince(threadId) {
  return runningTurns.since(threadId);
}

export function runningThreadIds() {
  return runningTurns.keys();
}
