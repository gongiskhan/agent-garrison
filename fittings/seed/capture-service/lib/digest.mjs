// The recording digest (plan G5): a recording started from a Conversations
// thread ends with ONE assistant message posted back into that thread, and a
// push whose deep link opens it. The digest is built from the ended session
// record and its transcript, posted through the same REST lane the shell
// mounts at /api/threads/:id/messages, and keyed by the session id so a
// replayed session end (reconnect, restart, double finalize) posts nothing
// twice - the thread store dedupes on idempotencyKey.
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
    const posted = await fetchImpl(`${base}/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "assistant", text, ts: now().toISOString(), sessionId: record.id }],
        idempotencyKey: digestIdempotencyKey(record.id)
      }),
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
