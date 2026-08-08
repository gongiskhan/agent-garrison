// Heartbeat triage (spec M2). Per tick, in order:
//   1. rule filters with NO model (drop discarded, scope filters; no-action
//      conversations skip the task path but still feed memory extraction);
//   2. ONE batched model call over the whole pending batch (invariant I3 - an
//      empty inbox makes zero model calls; this module structurally cannot
//      make more than one call per tick);
//   3. card candidates -> Kanban board (origin_id dedupe, backlog, provenance
//      + ONE clearly marked source-context line - invariant I1);
//   4. memory candidates -> basic-memory vault files with provenance;
//   5. tip candidates -> tips queue (delivery is M3's job), per-day cap.
//
// Batch size is capped; overflow stays pending and carries to the next tick.

import path from "node:path";
import { atomicWriteJSON, readJSON, ulid } from "./store.mjs";

const MAX_TRIAGE_ATTEMPTS = 5;
const TRANSCRIPT_EXCERPT_CHARS = 1200;

// ---- Rule layer (zero model cost) ------------------------------------------

// -> { action: "drop", reason } | { action: "keep", taskPath: boolean }
export function ruleFilter(event, cfg) {
  const n = event.normalized;
  if (!n) return { action: "drop", reason: "no normalized payload" };
  if (cfg.dropDiscarded && n.discarded) return { action: "drop", reason: "discarded" };
  if (n.folder && cfg.blockedFolders.length > 0 && cfg.blockedFolders.includes(n.folder)) {
    return { action: "drop", reason: `blocked folder ${n.folder}` };
  }
  if (
    event.kind === "conversation" &&
    cfg.allowedCategories.length > 0 &&
    !cfg.allowedCategories.includes(n.category ?? "")
  ) {
    return { action: "drop", reason: `category ${n.category ?? "none"} not allowed` };
  }
  const openItems = n.action_items.filter((a) => !a.completed);
  return { action: "keep", taskPath: openItems.length > 0 };
}

// ---- Batched prompt ---------------------------------------------------------

export function buildTriagePrompt({ batch, projects }) {
  const projectList = projects.length > 0 ? projects.join(", ") : "(none known)";
  const blocks = batch.map(({ event, taskPath }) => {
    const n = event.normalized;
    const lines = [
      `### Event ${event.id}`,
      `- kind: ${event.kind}`,
      `- task-eligible: ${taskPath ? "yes" : "no (memory/tips only - do NOT emit cards for this event)"}`,
      `- occurred: ${event.occurred_at}`,
      n.title ? `- title: ${n.title}` : null,
      n.category ? `- category: ${n.category}` : null,
      n.folder ? `- folder: ${n.folder}` : null,
      n.overview ? `- overview: ${n.overview}` : null
    ].filter(Boolean);
    const openItems = n.action_items.filter((a) => !a.completed);
    if (openItems.length > 0) {
      lines.push(`- open action items:`);
      openItems.forEach((a, i) =>
        lines.push(`  ${i}. ${a.description}${a.priority ? ` (priority: ${a.priority})` : ""}`)
      );
    }
    if (n.decisions.length > 0) {
      lines.push(`- decisions: ${n.decisions.map((d) => d.decision).join(" | ")}`);
    }
    if (n.questions.length > 0) {
      lines.push(`- open questions: ${n.questions.map((q) => q.question).join(" | ")}`);
    }
    if (n.insights.length > 0) {
      lines.push(`- insights: ${n.insights.map((i) => i.insight).join(" | ")}`);
    }
    if (n.transcript_text) {
      lines.push(`- transcript excerpt:`);
      lines.push("```");
      lines.push(n.transcript_text.slice(0, TRANSCRIPT_EXCERPT_CHARS));
      lines.push("```");
    }
    return lines.join("\n");
  });

  return `You are Garrison's Omi-inbox triage step. Below are capture events from the user's always-on wearable (conversations and day summaries; transcripts mix Portuguese and English). Produce triage candidates as STRICT JSON - no prose, no markdown fence, just one JSON object.

Output schema:
{
  "cards": [{ "event_id": "...", "action_index": 0, "title": "...", "description": "...", "project": null }],
  "memories": [{ "event_id": "...", "title": "...", "content": "...", "tags": ["..."] }],
  "tips": [{ "event_id": "...", "text": "..." }]
}

Rules:
- cards: ONLY for events marked task-eligible: yes, one card per distinct open action item that is genuinely actionable by the user or their agent; action_index is the item's number from the event's open-action-items list. Write title/description in your own words (the source line is appended separately - do not include source quotes in the description). Keep the action's original language.
- project: one of [${projectList}] when the conversation clearly concerns it, else null. Never invent a project.
- memories: durable facts, preferences, decisions, or insights worth remembering long-term. NOT tasks. Write content in your own words; include concrete specifics.
- tips: at most one short, immediately useful suggestion per event, only when something clearly helps the user today. Usually empty.
- Skip completed items, small talk, and anything below the bar. Empty arrays are fine.
- EXCEPTION to the bar: an open action item that records an explicit instruction the user spoke to their assistant (imperatives like "send a message ...", "create a task ...", "remind me ...", "tell Gary ...") is NEVER small talk - always emit its card, even when the surrounding conversation is casual or family chatter.

${blocks.join("\n\n")}`;
}

// ---- Reply parsing ----------------------------------------------------------

export function parseTriageReply(reply) {
  if (typeof reply !== "string" || reply.trim() === "") return null;
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  return { cards: arr(parsed.cards), memories: arr(parsed.memories), tips: arr(parsed.tips) };
}

// ---- Tips queue (M3 delivers) ----------------------------------------------

export function tipsQueueDir(storeRoot) {
  return path.join(storeRoot, "tips-queue");
}

function tipsQueuedToday(storeRoot, today) {
  const ledger = readJSON(path.join(storeRoot, "tips-ledger.json"), {});
  return ledger[today] ?? 0;
}

function bumpTipsLedger(storeRoot, today) {
  const file = path.join(storeRoot, "tips-ledger.json");
  const ledger = readJSON(file, {});
  ledger[today] = (ledger[today] ?? 0) + 1;
  atomicWriteJSON(file, ledger);
}

// ---- The tick ---------------------------------------------------------------

// Dependencies are injected so tests drive everything without a network:
// runFn ({prompt} -> {reply}), board (BoardClient shape), memoryWriter.
export async function runTriageTick({ cfg, store, counters, runFn, board, memoryWriter, notifier = null, log = console, now = new Date() }) {
  const summary = {
    modelCalls: 0,
    dropped: 0,
    cardsCreated: 0,
    cardsDeduped: 0,
    cardsSuppressed: 0,
    memoriesWritten: 0,
    memoriesSkipped: 0,
    tipsQueued: 0,
    tipsCapped: 0,
    triaged: 0,
    overflow: 0,
    skipped: null,
    error: null
  };

  if (!cfg.triageEnabled) {
    summary.skipped = "triage disabled";
    return summary;
  }

  // I3: an empty inbox makes NO model call and contacts nothing.
  const pending = store.listEvents("pending");
  if (pending.length === 0) {
    summary.skipped = "empty inbox";
    return summary;
  }

  // Rule layer first - free, applies to the whole pending set.
  const kept = [];
  for (const event of pending) {
    const verdict = ruleFilter(event, cfg);
    if (verdict.action === "drop") {
      store.updateEvent(event.id, (ev) => ({ ...ev, status: "dropped", drop_reason: verdict.reason }));
      counters.bump("dropped_by_rule");
      summary.dropped++;
    } else {
      kept.push({ event, taskPath: verdict.taskPath });
    }
  }
  if (kept.length === 0) {
    summary.skipped = "nothing kept after rules";
    return summary;
  }

  const batch = kept.slice(0, cfg.triageBatchCap);
  summary.overflow = kept.length - batch.length;
  if (summary.overflow > 0) counters.bump("triage_overflow", summary.overflow);

  // Preconditions for the one model call: gateway configured, board reachable
  // (cards are the main output; a tick that burned the model call and then
  // found the board down would waste the call - check first, cheap).
  if (!cfg.gatewayUrl) {
    summary.skipped = "no gateway URL";
    counters.bump("triage_skipped_no_gateway");
    return summary;
  }
  if (!(await board.reachable())) {
    summary.skipped = "board unreachable";
    counters.bump("triage_skipped_board_down");
    return summary;
  }

  const projects = await board.listProjects();
  const prompt = buildTriagePrompt({ batch, projects });

  let reply = null;
  try {
    summary.modelCalls = 1;
    counters.bump("triage_model_calls");
    const result = await runFn({ prompt });
    reply = result?.reply ?? "";
  } catch (err) {
    if (err?.transport) {
      // Gateway restarting - events stay pending, retry next tick, no attempt
      // consumed (kanban's transport-vs-real-failure discipline).
      summary.error = "transport";
      counters.bump("triage_transport_errors");
      return summary;
    }
    return failBatch(batch, store, counters, summary, `model call failed: ${err?.message ?? err}`);
  }

  const parsed = parseTriageReply(reply);
  if (!parsed) {
    counters.bump("triage_parse_failed");
    return failBatch(batch, store, counters, summary, "unparseable triage reply");
  }

  const batchById = new Map(batch.map((b) => [b.event.id, b]));
  const result = { cards: [], memories: [], tips: [], projects };

  // ---- cards -> board (I1/I4) ----
  for (const candidate of parsed.cards) {
    const entry = batchById.get(candidate?.event_id);
    if (!entry) continue;
    if (!entry.taskPath) {
      summary.cardsSuppressed++;
      counters.bump("cards_suppressed_no_action");
      continue;
    }
    const event = entry.event;
    const n = event.normalized;
    const openItems = n.action_items.filter((a) => !a.completed);
    const idx = Number.isInteger(candidate.action_index) ? candidate.action_index : 0;
    const sourceItem = openItems[idx] ?? openItems[0] ?? null;
    const conversationRef = event.provenance.omi_conversation_id ?? event.id;
    const originId = `omi:${conversationRef}:${idx}`;

    const existing = await board.findByOriginId(originId);
    if (existing.length > 0) {
      summary.cardsDeduped++;
      counters.bump("cards_deduped");
      continue;
    }

    const title = (candidate.title ?? sourceItem?.description ?? n.title ?? "Omi task").trim();
    const project = projects.includes(candidate.project) ? candidate.project : null;
    // I1: the body is OUR text plus ONE clearly marked source-context line and
    // the provenance link; Omi prose never masquerades as Garrison output.
    const sourceContext = (sourceItem?.description ?? n.overview ?? "").replace(/\s+/g, " ").slice(0, 200);
    const description = [
      (candidate.description ?? "").trim() || title,
      "",
      `Source (Omi): "${sourceContext}"`,
      `Provenance: omi conversation ${conversationRef}, capture event ${event.id}`
    ].join("\n");

    try {
      const card = await board.createCard({
        title,
        description,
        ...(project ? { project } : {}),
        origin: "omi",
        origin_id: originId,
        // Card lifecycle events (finished / needs-attention) route back to
        // this channel through kanban notify-origin's CHANNEL_FITTINGS map +
        // this fitting's thread-append contract.
        originChannel: { channel: "omi", threadId: "omi-reports" }
      });
      summary.cardsCreated++;
      counters.bump("cards_created");
      result.cards.push({ originId, cardId: card?.id ?? null, title, project });
      if (notifier) {
        // Tailnet-paired when possible (the tapping phone is never on this
        // box); the notifier owns URL resolution.
        const cardUrl = typeof notifier.cardUrl === "function" ? await notifier.cardUrl(card?.id) : null;
        await notifier.send({ template: "card_created", params: { title, cardUrl } });
      }
    } catch (err) {
      log.error(`[omi-channel] card create failed (${originId}): ${err?.message ?? err}`);
      counters.bump("cards_create_failed");
    }
  }

  // ---- memories -> vault (provenance required) ----
  for (const candidate of parsed.memories) {
    const entry = batchById.get(candidate?.event_id);
    if (!entry) continue;
    const event = entry.event;
    const written = memoryWriter.write({
      title: candidate.title ?? event.normalized.title ?? "Omi capture",
      content: candidate.content ?? "",
      tags: [
        ...(Array.isArray(candidate.tags) ? candidate.tags : []),
        ...(event.normalized.category ? [event.normalized.category] : [])
      ],
      provenance: {
        when: event.occurred_at,
        source: "omi",
        "omi conversation": event.provenance.omi_conversation_id ?? null,
        "capture event": event.id,
        kind: event.kind
      },
      now
    });
    if (written.ok) {
      summary.memoriesWritten++;
      counters.bump("memories_written");
      result.memories.push({ file: written.file, eventId: event.id });
    } else {
      summary.memoriesSkipped++;
      counters.bump("memories_skipped");
    }
  }

  // ---- tips -> queue (delivery is M3; per-day cap here) ----
  if (cfg.tipsEnabled) {
    const today = now.toISOString().slice(0, 10);
    for (const candidate of parsed.tips) {
      const entry = batchById.get(candidate?.event_id);
      const text = typeof candidate?.text === "string" ? candidate.text.trim() : "";
      if (!entry || !text) continue;
      if (tipsQueuedToday(store.root, today) >= cfg.tipsMaxPerDay) {
        summary.tipsCapped++;
        counters.bump("tips_capped");
        continue;
      }
      const tipId = ulid();
      atomicWriteJSON(path.join(tipsQueueDir(store.root), `${tipId}.json`), {
        id: tipId,
        text,
        eventId: entry.event.id,
        created: now.toISOString()
      });
      bumpTipsLedger(store.root, today);
      summary.tipsQueued++;
      counters.bump("tips_queued");
    }
  }

  // ---- mark the batch triaged with a durable result ref ----
  const resultId = ulid();
  const resultRef = path.join("triage-results", `${resultId}.json`);
  atomicWriteJSON(path.join(store.root, resultRef), {
    id: resultId,
    at: now.toISOString(),
    eventIds: batch.map((b) => b.event.id),
    ...result
  });
  for (const { event } of batch) {
    store.updateEvent(event.id, (ev) => ({ ...ev, status: "triaged", triage_result_ref: resultRef }));
    summary.triaged++;
  }
  counters.bump("events_triaged", batch.length);

  return summary;
}

// A non-transport failure consumes an attempt; after MAX_TRIAGE_ATTEMPTS the
// batch's events park as failed instead of burning a model call every tick.
function failBatch(batch, store, counters, summary, reason) {
  for (const { event } of batch) {
    store.updateEvent(event.id, (ev) => {
      const attempts = (ev.triage_attempts ?? 0) + 1;
      if (attempts >= MAX_TRIAGE_ATTEMPTS) {
        counters.bump("events_failed");
        return { ...ev, triage_attempts: attempts, status: "failed", failure_reason: reason };
      }
      return { ...ev, triage_attempts: attempts };
    });
  }
  summary.error = reason;
  return summary;
}
