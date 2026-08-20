// Session -> capture_event emission (the M4 seam, called on session end).
//
// One event per session, EVER (invariant I7: dedupe by session id — a
// re-finalized or replayed session must not enqueue twice), emitted only at
// session end (so an open session can never be carded — half of the
// wait-for-context behaviour; the thin-fragment hold in the shared triage
// rule layer is the other half, keyed on the stats this emitter stamps).
//
// The event is the SOURCE-AGNOSTIC capture_event shape triage already reads
// (invariant I2): nothing downstream needs a companion-specific field. The
// consent context rides in provenance (invariant I6).

import path from "node:path";
import { readJSON, ulid } from "./store.mjs";

// "You: text" / "Speaker N: text" prose, the same flattened form omi's
// normalizer feeds triage — the model sees prose, never segment objects.
export function transcriptProse(segments) {
  return (segments ?? [])
    .map((s) => `${s.is_user ? "You" : `Speaker ${s.speaker ?? "?"}`}: ${s.text}`)
    .join("\n");
}

export function emitSessionEvent({ record, store, counters, cfg, log = console, now = () => new Date() }) {
  if (store.sessionEventId(record.id)) {
    counters.bump("events_deduped_session");
    return null;
  }
  const transcript = record.transcript_ref ? readJSON(path.join(store.root, record.transcript_ref)) : null;
  const segments = transcript?.segments ?? [];
  if (segments.length === 0) {
    // Media without words has nothing for triage; the session record and its
    // media remain browsable in the view either way.
    counters.bump("events_skipped_no_transcript");
    return null;
  }

  // A pendant session (mode "pendant", only reachable here under the ambient
  // capture policy - wake_only sessions never persist a transcript, so they
  // skip out above) carries its own source identity end to end (ADR D7).
  const isPendant = record.mode === "pendant";
  const event = {
    id: ulid(),
    source: isPendant ? "pendant" : "companion-ios",
    uid: null,
    received_at: now().toISOString(),
    occurred_at: record.started_at ?? now().toISOString(),
    kind: "session",
    normalized: {
      title: isPendant
        ? "Pendant audio session"
        : `Companion ${record.mode === "screen_audio" ? "screen" : "audio"} session`,
      transcript_text: transcriptProse(segments),
      stats: {
        words: transcript.words ?? 0,
        segments: segments.length,
        // The wait-for-context floor travels ON the event so the shared rule
        // layer needs no companion config of its own.
        hold_floor: cfg.minTranscriptWords
      },
      action_items: [],
      decisions: [],
      questions: [],
      highlights: [],
      insights: []
    },
    provenance: {
      [isPendant ? "pendant_session_id" : "companion_session_id"]: record.id,
      mode: record.mode,
      consent: record.consent,
      device_name: record.device_name,
      end_reason: record.ended?.reason ?? null
    },
    status: "pending",
    triage_result_ref: null
  };
  store.writeEvent(event);
  store.recordSessionEvent(record.id, event.id);
  counters.bump("events_emitted");
  log.log(`[capture-service] session ${record.id} emitted capture_event (${event.normalized.stats.words} words)`);
  return event;
}
