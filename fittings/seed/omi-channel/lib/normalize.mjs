// Normalization: raw Omi webhook payloads -> capture_event (invariant I2:
// source-agnostic schema; triage and everything downstream read ONLY the
// normalized shape, never Omi field names). Shapes verified against
// docs/omi-api-notes.md (note speakerId is camelCase in Omi segments).
//
// Zero model calls here (invariant I3): normalization is pure mapping.

// A capture_event:
// { id, source, uid, received_at, occurred_at, kind, normalized, raw_ref,
//   provenance, status, triage_result_ref, day_key? }
// normalized: { title?, overview?, category?, folder?, discarded?, language_hint?,
//   action_items[{description, completed, priority?, source_ref}],
//   events[{title, start?, description?}], decisions[{decision, source_ref}],
//   questions[{question, source_ref}], highlights[{topic, summary, source_ref}],
//   insights[{insight, source_ref}], stats?, transcript_text? }

function str(v) {
  return typeof v === "string" ? v : null;
}

function bool(v, fallback = false) {
  return typeof v === "boolean" ? v : fallback;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// Transcript segments -> a plain "Speaker: text" block. Source-agnostic:
// triage sees prose, not Omi segment objects. Speaker label preference:
// speaker_name (memory trigger only) > "You" for is_user > diarization label.
export function transcriptText(segments) {
  const lines = [];
  for (const seg of arr(segments)) {
    const text = str(seg?.text)?.trim();
    if (!text) continue;
    const name = str(seg?.speaker_name) || (seg?.is_user === true ? "You" : str(seg?.speaker) || "Speaker");
    lines.push(`${name}: ${text}`);
  }
  return lines.join("\n");
}

export function normalizeConversation({ id, uid, receivedAt, raw }) {
  const structured = raw?.structured ?? {};
  const conversationId = str(raw?.id);
  return {
    id,
    source: "omi",
    uid,
    received_at: receivedAt,
    occurred_at: str(raw?.started_at) || str(raw?.created_at) || receivedAt,
    kind: "conversation",
    normalized: {
      title: str(structured.title),
      overview: str(structured.overview),
      category: str(structured.category),
      folder: str(raw?.folder_name),
      discarded: bool(raw?.discarded, false),
      action_items: arr(structured.action_items)
        .map((a) => ({
          description: str(a?.description) ?? "",
          completed: bool(a?.completed, false),
          source_ref: conversationId
        }))
        .filter((a) => a.description.length > 0),
      events: arr(structured.events)
        .map((e) => ({
          title: str(e?.title) ?? "",
          start: str(e?.start),
          description: str(e?.description)
        }))
        .filter((e) => e.title.length > 0),
      decisions: [],
      questions: [],
      highlights: [],
      insights: [],
      transcript_text: transcriptText(raw?.transcript_segments)
    },
    provenance: { omi_conversation_id: conversationId },
    status: "pending",
    triage_result_ref: null
  };
}

export function normalizeDaySummary({ id, uid, receivedAt, raw }) {
  // Use summary_json ONLY; the legacy `summary` string is a Python str(dict)
  // literal and is ignored by design (spec + verified docs).
  const s = raw?.summary_json ?? {};
  const dayKey = str(s.date) || (str(raw?.created_at) || receivedAt).slice(0, 10);
  return {
    id,
    source: "omi",
    uid,
    received_at: receivedAt,
    occurred_at: str(raw?.created_at) || receivedAt,
    kind: "day_summary",
    day_key: dayKey,
    normalized: {
      title: str(s.headline),
      overview: str(s.overview),
      category: null,
      folder: null,
      discarded: false,
      stats: typeof s.stats === "object" && s.stats !== null ? s.stats : null,
      action_items: arr(s.action_items)
        .map((a) => ({
          description: str(a?.description) ?? "",
          completed: bool(a?.completed, false),
          priority: str(a?.priority),
          source_ref: str(a?.source_conversation_id)
        }))
        .filter((a) => a.description.length > 0),
      events: [],
      decisions: arr(s.decisions_made)
        .map((d) => ({ decision: str(d?.decision) ?? "", source_ref: str(d?.conversation_id) }))
        .filter((d) => d.decision.length > 0),
      questions: arr(s.unresolved_questions)
        .map((q) => ({ question: str(q?.question) ?? "", source_ref: str(q?.conversation_id) }))
        .filter((q) => q.question.length > 0),
      highlights: arr(s.highlights)
        .map((h) => ({
          topic: str(h?.topic) ?? "",
          summary: str(h?.summary),
          source_ref: arr(h?.conversation_ids)[0] ?? null
        }))
        .filter((h) => h.topic.length > 0),
      insights: arr(s.knowledge_nuggets)
        .map((n) => ({ insight: str(n?.insight) ?? "", source_ref: str(n?.conversation_id) }))
        .filter((n) => n.insight.length > 0),
      transcript_text: null
    },
    provenance: { omi_day_summary_id: str(s.id) },
    status: "pending",
    triage_result_ref: null
  };
}

export function failedEvent({ id, uid, receivedAt, kind, reason }) {
  return {
    id,
    source: "omi",
    uid: uid ?? null,
    received_at: receivedAt,
    occurred_at: receivedAt,
    kind: kind ?? "conversation",
    normalized: null,
    provenance: {},
    status: "failed",
    failure_reason: reason,
    triage_result_ref: null
  };
}
