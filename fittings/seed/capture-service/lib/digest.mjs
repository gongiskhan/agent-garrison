// The recording digest (plan G5): a recording started from a Conversations
// thread ends with ONE note posted back into that conversation, and a push
// whose deep link opens it. The digest is built from the ended session record
// and its transcript, posted through the conversation router's note door
// (POST /api/conversation/:id/note, a ledger record the view renders and no
// responder answers), and keyed by the session id so a replayed session end
// (reconnect, restart, double finalize) posts nothing twice - the door
// dedupes on clientRequestId.
//
// Only sessions that carried a conversation_id in session_start get a digest;
// a recording started from the capture page or Control Center has no thread
// to speak into and stays a plain session record.

import path from "node:path";
import { readJSON } from "./store.mjs";
import { transcriptProse } from "./events.mjs";
import { conversationsBaseUrl } from "./notify.mjs";

// How much transcript rides in the message. Long recordings keep the head and
// tail; the session record still holds the full transcript for the view.
export const DIGEST_TRANSCRIPT_CAP = 6000;

export function digestIdempotencyKey(sessionId) {
  return `capture-digest:${sessionId}`;
}

export function digestPath(record) {
  return record?.conversation_id ? `/talk/${record.conversation_id}` : null;
}

function describeMode(mode) {
  if (mode === "screen_audio") return "screen audio";
  if (mode === "pendant") return "pendant audio";
  return "microphone";
}

function describeDuration(record, now) {
  const start = Date.parse(record?.started_at ?? "");
  if (Number.isNaN(start)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function clipTranscript(text) {
  if (text.length <= DIGEST_TRANSCRIPT_CAP) return text;
  const head = text.slice(0, Math.floor(DIGEST_TRANSCRIPT_CAP * 0.7)).trimEnd();
  const tail = text.slice(-Math.floor(DIGEST_TRANSCRIPT_CAP * 0.3)).trimStart();
  return `${head}\n\n[...]\n\n${tail}`;
}

// Pure: the message text for an ended session. `transcript` is the parsed
// transcripts/<id>.json (or null when the session produced none).
export function buildDigest({ record, transcript, cfg, now = new Date() }) {
  const lines = [];
  const facts = [describeMode(record.mode)];
  const duration = describeDuration(record, now);
  if (duration) facts.push(duration);
  if (record.device_name) facts.push(`from ${record.device_name}`);
  lines.push(`Recording ended: ${facts.join(", ")}.`);

  const segments = transcript?.segments ?? [];
  if (segments.length > 0) {
    const words = transcript.words ?? null;
    lines.push("");
    lines.push(words ? `Transcript (${words} words):` : "Transcript:");
    lines.push("");
    lines.push(clipTranscript(transcriptProse(segments)));
  } else if (cfg?.transcribeEnabled === false) {
    lines.push("");
    lines.push("No transcript: transcription is off on this node (transcribe_enabled).");
  } else {
    lines.push("");
    lines.push("No transcript: no speech was recognised in the recording.");
  }
  lines.push("");
  lines.push(`Recording id ${record.id}.`);
  return lines.join("\n");
}

// Post the digest into the thread and push a deep link to it. Resolves to a
// receipt ({ ok, status?, skipped?, error? }); never throws - the session
// record is already written and a lost digest must not take anything with it.
export async function postConversationDigest({
  record,
  store,
  cfg,
  counters,
  notifier = null,
  env = process.env,
  fetchImpl = fetch,
  log = console,
  now = () => new Date()
}) {
  const threadId = record?.conversation_id;
  if (!threadId) return { ok: false, skipped: "no conversation_id" };
  const base = conversationsBaseUrl(env);
  if (!base) {
    counters?.bump("digest_skipped_no_app");
    return { ok: false, skipped: "no Conversations host: GARRISON_APP_URL unset" };
  }
  const transcript = record.transcript_ref && store ? readJSON(path.join(store.root, record.transcript_ref)) : null;
  const text = buildDigest({ record, transcript, cfg, now: now() });
  try {
    // A note, not a message: it lands in the conversation ledger the view
    // renders without opening a responder stretch (nobody should answer a
    // transcript). The session id keys the door's dedupe.
    const posted = await fetchImpl(`${base}/api/conversation/${encodeURIComponent(threadId)}/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, origin: "capture", clientRequestId: digestIdempotencyKey(record.id) }),
      signal: AbortSignal.timeout(8000)
    });
    if (!posted.ok) {
      counters?.bump("digest_post_failed");
      log.error(`[capture-service] digest for ${record.id} -> thread ${threadId}: HTTP ${posted.status}`);
      return { ok: false, status: posted.status };
    }
  } catch (err) {
    counters?.bump("digest_post_failed");
    log.error(`[capture-service] digest for ${record.id} -> thread ${threadId}: ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  }
  counters?.bump("digest_posted");
  log.log(`[capture-service] digest for ${record.id} -> thread ${threadId}`);

  // Push only: the digest already lives in the thread, so the Companion
  // thread fallback would only duplicate it somewhere else.
  if (notifier?.sendPush) {
    try {
      const push = await notifier.sendPush({
        title: "Recording digest",
        body: text.split("\n")[0],
        link: null,
        path: digestPath(record),
        tag: "recording_digest",
        priority: "routine"
      });
      return { ok: true, push };
    } catch (err) {
      return { ok: true, push: { ok: false, error: err?.message ?? String(err) } };
    }
  }
  return { ok: true, push: null };
}

// A wake hit inside a broadcast is a USER turn in the conversation the REC
// button lived in, not a digest: the words after the wake word become the
// message and the latest screen frames ride along as attached files, using
// the same "Attached file(s):" convention the composer writes for uploads
// so the runtime reads them the way it reads a pasted screenshot. Admission
// goes through the conversation door (POST /api/conversation/:id/message),
// the same one the composer's Send uses, so the turn is a record in the
// conversation ledger the view renders and a responder stretch answers it.
// The thread's older /inputs lane still exists, but a conversation-backed
// thread never paints it: a turn posted there ran and was answered without
// the person ever seeing either (the 2026-09-03 phone run).
export function conversationTurnMessage({ command, frames = [] }) {
  const text = String(command ?? "").trim();
  const files = frames.map((f) => f?.file).filter(Boolean);
  if (files.length === 0) return text;
  return `${text}\n\n${files.length === 1 ? "Attached file" : "Attached files"}:\n${files.map((f) => `- ${f}`).join("\n")}`;
}

export async function postConversationTurn({
  conversationId,
  command,
  eventId,
  frames = [],
  counters = null,
  env = process.env,
  fetchImpl = fetch,
  log = console
}) {
  if (!conversationId) return { ok: false, reason: "no conversation_id" };
  const base = conversationsBaseUrl(env);
  if (!base) {
    counters?.bump("conversation_turn_skipped_no_app");
    return { ok: false, reason: "no Conversations host: GARRISON_APP_URL unset" };
  }
  const message = conversationTurnMessage({ command, frames });
  if (!message) return { ok: false, reason: "empty command" };
  const url = `${base}/talk/${encodeURIComponent(conversationId)}`;
  try {
    const posted = await fetchImpl(`${base}/api/conversation/${encodeURIComponent(conversationId)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // One wake hit is one turn: the event id keys the responder's dedupe.
      body: JSON.stringify({ message, origin: "capture", clientRequestId: `wake:${eventId}` }),
      signal: AbortSignal.timeout(8000)
    });
    if (!posted.ok) {
      counters?.bump("conversation_turn_post_failed");
      log.error(`[capture-service] wake turn ${eventId} -> thread ${conversationId}: HTTP ${posted.status}`);
      return { ok: false, reason: `HTTP ${posted.status}`, url };
    }
    const body = await posted.json().catch(() => ({}));
    counters?.bump("conversation_turn_posted");
    log.log(`[capture-service] wake turn ${eventId} -> thread ${conversationId} (${frames.length} frame${frames.length === 1 ? "" : "s"})`);
    return { ok: true, seq: typeof body?.seq === "number" ? body.seq : null, recordedBy: body?.recordedBy ?? null, url };
  } catch (err) {
    counters?.bump("conversation_turn_post_failed");
    log.error(`[capture-service] wake turn ${eventId} -> thread ${conversationId}: ${err?.message ?? err}`);
    return { ok: false, reason: err?.message ?? String(err), url };
  }
}
