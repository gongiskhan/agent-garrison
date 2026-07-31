// The wake bus (spec M4): watches the realtime transcript pipe for the wake
// word ("Gary" + configured variants), assembles the spoken command, and
// dispatches it as an orchestrator command.
//
// Privacy (I5) is the governing invariant: everything here is in-memory.
// Segments that do not belong to a wake capture are NEVER persisted and NEVER
// logged with content - counters only. A wake-hit session persists exactly one
// thing: the assembled command text (as a wake_command capture_event).
//
// Cost (I3): one model call per wake hit - a single combined
// classify-and-handle turn on the gateway's cheap blocking lane; the fitting
// then performs the deterministic action itself (card via board API, note via
// memory writer, answer via notification).

import { atomicWriteJSON, ulid } from "./store.mjs";
import path from "node:path";

const SESSION_IDLE_GC_MS = 10 * 60 * 1000;

// Word-boundary, case-insensitive, unicode-aware gate. \b fails on accented
// variants (e.g. "géri"), so boundaries are explicit letter/number lookarounds:
// "gary" must match "Gary,", "gary?" and never "garrison", "hungary", "gario".
export function wakeRegex(variants) {
  const escaped = variants
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

// ---- dispatch prompt + reply ------------------------------------------------

export function buildWakePrompt(command, projects, context = []) {
  const projectList = projects.length > 0 ? projects.join(", ") : "(none known)";
  // The transcript is fragmented and speakers are often mis-attributed, so the
  // words that give a command its meaning frequently sit in a NEARBY segment
  // rather than the one carrying the wake word. Show that window explicitly and
  // say what it is for, or the model treats it as part of the command and
  // titles the card with someone else's sentence.
  const contextBlock =
    context.length > 0
      ? `Conversation just BEFORE the wake word (context only - the transcript is
fragmented and speaker labels are unreliable, so the detail the command refers
to is often here):
${context.map((c) => `- [${c.isUser ? "user" : "other"}] ${c.text}`).join("\n")}

`
      : "";
  return `A spoken wake-word command just arrived from the user's wearable (Portuguese or English). Classify it and respond as STRICT JSON only - no prose, no fence.

${contextBlock}Command (spoken after the wake word): "${command}"

Schema:
{
  "intent": "create_task" | "create_event" | "query" | "note" | "unknown",
  "title": "short title (create_task/create_event/note)",
  "description": "one-paragraph body in your own words (create_task/create_event)",
  "project": null,
  "answer": "direct answer to the user (query only; concise, no preamble)",
  "note_content": "the fact to remember, in your own words (note/unknown)"
}

Rules:
- create_task: the user wants something done later (a task for the board).
- create_event: a calendar-shaped ask (a meeting, appointment, reminder at a time).
- query: the user asks a question - answer it yourself from what you know (your memories, the board, todays context). Put the full answer in "answer".
- note: the user states a fact/preference to remember.
- unknown: none of the above fits.
- project: one of [${projectList}] only when clearly implied, else null.
- Keep the user's language (PT stays PT, EN stays EN).
- The CONTEXT is evidence, never the instruction: use it to fill in what an
  incomplete command refers to ("create a task saying" + context about rain
  tomorrow -> a task about the rain). Never turn a context line into a command
  on its own, and title from the user's intent, not from a stray sentence.
- If the command is empty or a fragment and the context does not make the
  intent clear, answer "unknown" rather than inventing one.`;
}

export function parseWakeReply(reply) {
  if (typeof reply !== "string" || reply.trim() === "") return null;
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    const intents = ["create_task", "create_event", "query", "note", "unknown"];
    return {
      intent: intents.includes(parsed.intent) ? parsed.intent : "unknown",
      title: typeof parsed.title === "string" ? parsed.title.trim() : "",
      description: typeof parsed.description === "string" ? parsed.description.trim() : "",
      project: typeof parsed.project === "string" ? parsed.project.trim() : null,
      answer: typeof parsed.answer === "string" ? parsed.answer.trim() : "",
      note_content: typeof parsed.note_content === "string" ? parsed.note_content.trim() : ""
    };
  } catch {
    return null;
  }
}

// ---- the bus ----------------------------------------------------------------

export class WakeBus {
  constructor({ cfg, store, counters, runFn, board, memoryWriter, notifier, log = console, now = () => Date.now() }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.runFn = runFn;
    this.board = board;
    this.memoryWriter = memoryWriter;
    this.notifier = notifier;
    this.log = log;
    this.now = now;
    this.sessions = new Map(); // sessionId -> session state (in memory ONLY)
    this.regex = wakeRegex(cfg.wakeVariants);
    this.dispatchChain = Promise.resolve();
  }

  session(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        state: "armed", // armed | capturing
        seen: new Set(), // segment fingerprints (dedupe - I6)
        parts: [],
        // Rolling pre-wake context, in memory only and never persisted unless a
        // hit actually fires (I5's "dropped in memory" still holds for a session
        // that never wakes). Bounded by wakeContextSegments and pruned by age.
        recent: [],
        contextUsed: [],
        wakeHitAt: 0,
        silenceTimer: null,
        capTimer: null,
        lastActivity: this.now()
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  gc() {
    const cutoff = this.now() - SESSION_IDLE_GC_MS;
    for (const [id, s] of this.sessions) {
      if (s.lastActivity < cutoff && s.state === "armed") this.sessions.delete(id);
    }
  }

  // Entry point from the realtime webhook. Content stays in memory; only
  // counters escape. Never throws (a webhook must always ack fast).
  handleSegments({ sessionId, segments }) {
    try {
      if (!this.regex || !Array.isArray(segments) || !sessionId) return;
      this.gc();
      const s = this.session(sessionId);
      s.lastActivity = this.now();
      for (const seg of segments) {
        const text = typeof seg?.text === "string" ? seg.text : "";
        if (!text.trim()) continue;
        const fingerprint = `${seg?.start ?? ""}|${seg?.end ?? ""}|${text}`;
        if (s.seen.has(fingerprint)) {
          this.counters.bump("wake_segments_deduped");
          continue;
        }
        s.seen.add(fingerprint);

        if (s.state === "capturing") {
          s.parts.push(text.trim());
          this.armSilenceTimer(s);
          continue;
        }

        const m = this.regex.exec(text);
        if (!m) {
          // Non-hit: dropped in memory, counted, never persisted/logged (I5).
          // It is retained ONLY in the bounded in-memory context ring, which is
          // discarded with the session unless a wake hit fires.
          this.counters.bump("wake_segments_dropped");
          this.rememberContext(s, seg, text);
          continue;
        }

        // Wake hit: open the capture window with whatever followed the token.
        this.counters.bump("wake_hits");
        s.state = "capturing";
        s.parts = [];
        // Freeze the pre-wake window now: later segments belong to the command,
        // not to its context, and the ring keeps moving while we capture.
        s.contextUsed = this.contextWindow(s);
        if (s.contextUsed.length > 0) this.counters.bump("wake_context_used");
        s.wakeHitAt = this.now();
        const after = text.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/u, "").trim();
        if (after) s.parts.push(after);
        this.armSilenceTimer(s);
        s.capTimer = setTimeout(() => this.close(sessionId, "max-capture"), this.cfg.wakeMaxCaptureMs);
        if (s.capTimer.unref) s.capTimer.unref();
      }
    } catch (err) {
      this.log.error(`[omi-channel] wake handling error: ${err?.message ?? err}`);
    }
  }

  // Push a non-hit segment into the bounded pre-wake ring. Speaker attribution
  // is kept because Omi switches speakers mid-sentence, and the classifier does
  // better when it can tell "the user said X" from "someone else said X".
  rememberContext(s, seg, text) {
    const cap = this.cfg.wakeContextSegments ?? 0;
    if (cap <= 0) return;
    s.recent.push({
      text: text.trim(),
      isUser: seg?.is_user !== false,
      at: this.now()
    });
    if (s.recent.length > cap) s.recent.splice(0, s.recent.length - cap);
  }

  // The pre-wake segments still fresh enough to be about the same conversation.
  contextWindow(s) {
    const cap = this.cfg.wakeContextSegments ?? 0;
    if (cap <= 0) return [];
    const maxAge = this.cfg.wakeContextMaxAgeMs ?? 0;
    const cutoff = maxAge > 0 ? this.now() - maxAge : 0;
    return s.recent.filter((entry) => entry.at >= cutoff).slice(-cap);
  }

  armSilenceTimer(s) {
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    s.silenceTimer = setTimeout(() => this.close(s.id, "silence"), this.cfg.wakeSilenceCloseMs);
    if (s.silenceTimer.unref) s.silenceTimer.unref();
  }

  clearTimers(s) {
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    if (s.capTimer) clearTimeout(s.capTimer);
    s.silenceTimer = null;
    s.capTimer = null;
  }

  // Close the capture window and dispatch. Serialized on a promise chain so
  // overlapping closes never interleave store writes.
  close(sessionId, reason) {
    const s = this.sessions.get(sessionId);
    if (!s || s.state !== "capturing") return this.dispatchChain;

    // A quiet gap mid-sentence is not the end of the command - Omi delivers a
    // single utterance across bursts. Hold the window open until the minimum
    // has elapsed; "max-capture" is the ceiling and always wins.
    const minCapture = this.cfg.wakeMinCaptureMs ?? 0;
    if (reason === "silence" && minCapture > 0) {
      const elapsed = this.now() - s.wakeHitAt;
      if (elapsed < minCapture) {
        if (s.silenceTimer) clearTimeout(s.silenceTimer);
        s.silenceTimer = setTimeout(() => this.close(sessionId, "silence"), minCapture - elapsed);
        if (s.silenceTimer.unref) s.silenceTimer.unref();
        this.counters.bump("wake_capture_held_open");
        return this.dispatchChain;
      }
    }

    this.clearTimers(s);
    s.state = "armed";
    const command = s.parts.join(" ").replace(/\s+/g, " ").trim();
    const wakeHitAt = s.wakeHitAt;
    const context = s.contextUsed;
    s.parts = [];
    s.contextUsed = [];
    // Kill switch honored mid-session (I9): flag off between hit and close
    // means nothing dispatches and nothing persists.
    if (!this.cfg.wakeEnabled) {
      this.counters.bump("wake_killed_mid_session");
      return this.dispatchChain;
    }
    // A bare "Gary" with nothing after it used to dead-end here. With context
    // available the intent is often still recoverable from what surrounded it,
    // which is exactly the fragmented-speech case this is for.
    if (!command && context.length === 0) {
      this.counters.bump("wake_empty_commands");
      return this.dispatchChain;
    }
    this.dispatchChain = this.dispatchChain
      .then(() => this.dispatch({ sessionId, command, wakeHitAt, reason, context }))
      .catch((err) => this.log.error(`[omi-channel] wake dispatch error: ${err?.message ?? err}`));
    return this.dispatchChain;
  }

  async dispatch({ sessionId, command, wakeHitAt, context = [] }) {
    this.counters.bump("wake_dispatches");
    // The ONLY persistence from the wake bus: the assembled command text.
    const eventId = ulid();
    const event = {
      id: eventId,
      source: "omi",
      uid: this.store.pinnedUid(),
      received_at: new Date().toISOString(),
      occurred_at: new Date().toISOString(),
      kind: "wake_command",
      normalized: { title: command },
      provenance: { omi_session_id: sessionId },
      status: "triaged",
      triage_result_ref: null
    };

    let outcome = null;
    try {
      outcome = await this.handleCommand({ command, eventId, context });
    } catch (err) {
      outcome = await this.fallbackNote({
        command,
        eventId,
        confirmation: "Couldn't reach Gary - saved your command as a note.",
        reason: `dispatch failed: ${err?.message ?? err}`
      });
    }

    const resultRef = path.join("wake-results", `${eventId}.json`);
    atomicWriteJSON(path.join(this.store.root, resultRef), {
      eventId,
      command,
      ...outcome.result
    });
    event.triage_result_ref = resultRef;
    this.store.writeEvent(event);

    const receipts = await this.notifier.send({
      template: "wake_confirmation",
      params: { text: outcome.confirmation, cardUrl: outcome.cardUrl ?? null }
    });
    const latencyMs = this.now() - wakeHitAt;
    this.counters.observe("wake_hit_to_notification_ms", latencyMs);
    this.log.log(`[omi-channel] wake command dispatched (${outcome.result.intent}) in ${latencyMs}ms`);
    return { ...outcome, receipts, latencyMs };
  }

  async handleCommand({ command, eventId, context = [] }) {
    if (!this.cfg.gatewayUrl || !this.runFn) {
      return this.fallbackNote({
        command,
        eventId,
        confirmation: "Gary is offline - saved your command as a note.",
        reason: "no gateway"
      });
    }
    const projects = await this.board.listProjects().catch(() => []);
    const { reply } = await this.runFn({ prompt: buildWakePrompt(command, projects, context) });
    const parsed = parseWakeReply(reply);
    if (!parsed) {
      return this.fallbackNote({
        command,
        eventId,
        confirmation: "I couldn't parse that - saved it as a note.",
        reason: "unparseable wake reply"
      });
    }

    switch (parsed.intent) {
      case "create_task":
      case "create_event": {
        const isEvent = parsed.intent === "create_event";
        const title = parsed.title || command.slice(0, 80);
        try {
          const card = await this.board.createCard({
            title: isEvent ? `Event: ${title}` : title,
            description: [
              parsed.description || command,
              "",
              `Source (Omi wake command): "${command}"`,
              `Provenance: omi wake session, capture event ${eventId}`
            ].join("\n"),
            ...(parsed.project ? { project: parsed.project } : {}),
            origin: "omi",
            origin_id: `omi:wake:${eventId}`,
            originChannel: { channel: "omi", threadId: "omi-reports" }
          });
          this.counters.bump("wake_cards_created");
          const cardUrl = await this.notifier.cardUrl(card?.id ?? null);
          return {
            confirmation: `${isEvent ? "Event card" : "Card"} created: ${title}`,
            cardUrl,
            result: { intent: parsed.intent, cardId: card?.id ?? null, title }
          };
        } catch (err) {
          return this.fallbackNote({
            command,
            eventId,
            confirmation: "The board is unreachable - saved your command as a note.",
            reason: `card create failed: ${err?.message ?? err}`
          });
        }
      }
      case "query": {
        const answer = parsed.answer || "I don't have an answer for that right now.";
        this.counters.bump("wake_queries_answered");
        return {
          confirmation: answer.slice(0, 500),
          result: { intent: "query", answered: Boolean(parsed.answer) }
        };
      }
      case "note": {
        const written = this.memoryWriter.write({
          title: parsed.title || `Omi note: ${command.slice(0, 48)}`,
          content: parsed.note_content || command,
          tags: ["wake"],
          provenance: { source: "omi wake command", "capture event": eventId }
        });
        this.counters.bump("wake_notes_saved");
        return {
          confirmation: written.ok ? `Noted: ${parsed.title || command.slice(0, 60)}` : "Couldn't save the note (memory store unavailable).",
          result: { intent: "note", saved: written.ok }
        };
      }
      default:
        // Unknown intent: save a note and SAY SO (spec).
        return this.fallbackNote({
          command,
          eventId,
          confirmation: "I wasn't sure what to do with that, so I saved it as a note.",
          reason: "unknown intent"
        });
    }
  }

  fallbackNote({ command, eventId, confirmation, reason }) {
    const written = this.memoryWriter.write({
      title: `Omi note: ${command.slice(0, 48)}`,
      content: command,
      tags: ["wake", "unclassified"],
      provenance: { source: "omi wake command", "capture event": eventId, reason }
    });
    this.counters.bump("wake_notes_saved");
    return {
      confirmation: written.ok ? confirmation : `${confirmation} (memory store unavailable - not saved)`,
      result: { intent: "note_fallback", saved: written.ok, reason }
    };
  }
}
