// Conversation store -> canonical SessionEvent adapter (Conversations plan, C1).
//
// The renderer has ONE vocabulary: the SessionEvent journal (journal.ts). A
// conversation is not a parallel lane beside it - it is that same vocabulary,
// produced from the append-only ledger instead of from a runtime's stream. This
// module is the only place that translation happens, so every surface (web
// channel, kanban card modal, the Next app) renders a conversation identically.
//
// Two block types carry the conversation spine (added by A3, whitelisted in the
// web channel's threads.mjs sanitizer):
//
//   stretch  - one short-lived runtime session's boundary. `started` and `ended`
//              are the SAME event: the ended record REVISES the started one in
//              place (same stable id, revision 1), so the boundary settles
//              rather than doubling.
//   ledger   - a conversation fact rendered inline: a handoff, a delegation, a
//              card transition, an escalation, a policy rewrite.
//
// Everything else the store records (digs, and any kind a future writer invents)
// is deliberately NOT rendered: a read-trace is not a fact about the work, and
// inventing a row for an unknown kind would be a lie about what happened.

/**
 * The id an adapter stamps on the SessionEvent it mints for conversation-store
 * record `seq` (= the store's stable read-time `index`), and the id a search-hit
 * jump looks for.
 *
 * MUST stay byte-identical to `conversationEventId` in
 * packages/claude-chat/src/ConversationView.tsx - the producer lives here, the
 * consumer lives there, and a drift makes search-hit landing silently inert.
 * `tests/conversation-store-read.test.ts` asserts the two against each other.
 */
export function conversationEventId(conversationId, seq) {
  return `${conversationId}#${seq}`;
}

/** The ledger kinds the renderer speaks (journal.ts `SessionLedgerKind`, mirrored
 *  by threads.mjs SESSION_LEDGER_KINDS). A CLOSED set: a block carrying a kind
 *  outside it is dropped by the sanitizer, taking its whole event with it. */
export const RENDERED_LEDGER_KINDS = [
  "handoff",
  "delegation-dispatched",
  "delegation-returned",
  "delegation-failed",
  "card-state-changed",
  "escalation",
  "policy-rewrite",
];

/**
 * Store kind -> rendered ledger kind. The store's vocabulary is OPEN (it grows
 * without redeploying every writer); the renderer's is CLOSED. Three store kinds
 * therefore land on their nearest in-set neighbour rather than being dropped:
 *
 *   conversation-opened -> card-state-changed  (the work item's first state)
 *   card-materialized   -> card-state-changed  (the work item becoming a card)
 *   summary-trimmed     -> policy-rewrite      (the platform rewriting L1 state)
 *
 * The real event name always survives in the row's TITLE, so the mapping costs
 * a filter facet, never a fact.
 */
const LEDGER_KIND_MAP = {
  handoff: "handoff",
  "delegation-dispatched": "delegation-dispatched",
  "delegation-returned": "delegation-returned",
  "delegation-failed": "delegation-failed",
  "card-state-changed": "card-state-changed",
  "card-materialized": "card-state-changed",
  "conversation-opened": "card-state-changed",
  escalation: "escalation",
  "policy-rewrite": "policy-rewrite",
  "summary-trimmed": "policy-rewrite",
  // The Autonomous gate's ask — rendered so the pause is visible IN the
  // conversation, not only as the card's attention reason.
  "approval-requested": "policy-rewrite",
};

const DETAIL_CAP = 4000;

/**
 * Adapt a batch of store log records into canonical SessionEvents.
 *
 * @param {Array<object>} events  store records, each carrying the read-time
 *   `index` the store assigned (line order across segments) - the coordinate the
 *   event id, `order` and search jumps are all built on.
 * @param {{conversationId: string, stretchStarts?: Map<string, object>}} opts
 *   `stretchStarts` lets a caller carry started-stretch positions ACROSS batches
 *   (the SSE stream does: an `ended` record arriving in a later poll must still
 *   revise the `started` event the client already painted). Omit it and pairing
 *   is per-batch, which is what a one-shot read wants.
 * @returns {Array<object>} SessionEvents, in record order.
 */
export function ledgerToSessionEvents(events, { conversationId, stretchStarts = null, eventSlots = null } = {}) {
  const cid = String(conversationId ?? "");
  const starts = stretchStarts ?? new Map();
  // Same continuity contract as stretchStarts, for teed session-events: a
  // later revision of one adapter event must land in the SAME chronological
  // slot with a bumped revision, or every throttle tick paints a new bubble.
  const slots = eventSlots ?? new Map();
  const out = [];
  for (const record of events ?? []) {
    if (!record || typeof record !== "object") continue;
    const adapted = adaptRecord(record, cid, starts, slots);
    if (adapted) out.push(adapted);
  }
  return out;
}

function adaptRecord(record, cid, starts, slots = new Map()) {
  const index = Number.isInteger(record.index) ? record.index : null;
  if (index === null) return null;
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  const ts = recordTs(record);

  // The stretch launcher's transcript tee (makeStretchEventTee): the adapter's
  // own SessionEvent rides the record verbatim — text, thinking and tool blocks
  // pass through so a conversation reads like the session it is. The event id
  // is namespaced per stretch (adapter ids are session-scoped and two stretches
  // may reuse them), revisions of one id share the FIRST record's slot, and the
  // stretch id becomes the turnId so groupSessionTurns folds the prose into its
  // stretch's turn. A spilled payload is a pointer, not an event — skipped.
  if (record.kind === "session-event") {
    if (payload.spilled) return null;
    if (typeof payload.id !== "string" || !payload.id || !Array.isArray(payload.blocks)) return null;
    const key = `ev:${typeof record.stretch === "string" ? record.stretch : ""}:${payload.id}`;
    const slot = slots.get(key) ?? null;
    const order = slot ? slot.order : index;
    const revision = slot ? slot.revision + 1 : 0;
    slots.set(key, { order, revision });
    return {
      ...payload,
      id: `${cid}#${key}`,
      // The channel sanitizer requires a NUMERIC ts (epoch ms) — an ISO string
      // from the adapter would null the whole event out of the transcript.
      ts: Number.isFinite(Date.parse(payload.ts)) ? Date.parse(payload.ts) : recordTs(record),
      order,
      revision,
      role: typeof payload.role === "string" ? payload.role : "assistant",
      ...(typeof record.stretch === "string" && record.stretch ? { turnId: record.stretch } : {}),
    };
  }

  const base = {
    id: conversationEventId(cid, index),
    ts,
    order: index,
    revision: 0,
  };

  if (record.kind === "user-message") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return null;
    return { ...base, role: "user", blocks: [{ type: "text", text }] };
  }

  if (record.kind === "stretch-started") {
    const stretchId = stretchIdOf(record, payload);
    if (!stretchId) return null;
    const attribution = attributionFromTarget(payload.target);
    const duty = dutyOf(record, payload);
    const chosenBy = label(payload.chosenBy);
    starts.set(stretchId, { index, ts, attribution, duty });
    return {
      ...base,
      role: "assistant",
      turnId: stretchId,
      blocks: [
        {
          type: "stretch",
          phase: "started",
          stretchId,
          attribution,
          ...(duty ? { duty } : {}),
          ...(chosenBy ? { chosenBy } : {}),
        },
      ],
    };
  }

  if (record.kind === "stretch-ended") {
    const stretchId = stretchIdOf(record, payload);
    // A `started` we have seen makes this a REVISION of that event: same id,
    // same chronological slot, revision 1. A started record outside the window
    // (the reader jumped past it) leaves no slot to revise, so the boundary is
    // emitted standalone rather than silently dropped.
    const started = stretchId ? starts.get(stretchId) : null;
    const duty = dutyOf(record, payload) ?? started?.duty ?? null;
    const attribution = started?.attribution ?? attributionFromEnded(payload);
    const block = {
      type: "stretch",
      phase: "ended",
      stretchId: stretchId || `stretch-${index}`,
      attribution,
      ...(duty ? { duty } : {}),
      ...(label(payload.outcome) ? { outcome: label(payload.outcome) } : {}),
      ...(Number.isFinite(payload.usedTokens) ? { usedTokens: payload.usedTokens } : {}),
      ...(Number.isFinite(payload.durationMs) ? { durationMs: payload.durationMs } : {}),
    };
    if (started) {
      return {
        id: conversationEventId(cid, started.index),
        ts,
        order: started.index,
        revision: 1,
        role: "assistant",
        ...(stretchId ? { turnId: stretchId } : {}),
        blocks: [block],
      };
    }
    return { ...base, role: "assistant", ...(stretchId ? { turnId: stretchId } : {}), blocks: [block] };
  }

  const kind = LEDGER_KIND_MAP[record.kind];
  if (!kind) return null; // dig, and anything the store learned after this build
  const row = ledgerRow(record, payload, kind, index);
  if (!row) return null;
  const stretchId = stretchIdOf(record, payload);
  return {
    ...base,
    role: "assistant",
    ...(stretchId ? { turnId: stretchId } : {}),
    blocks: [row],
  };
}

function ledgerRow(record, payload, kind, index) {
  const built = buildTitleAndDetail(record, payload);
  if (!built) return null;
  const payloadRef = normalizePayloadRef(payload.payloadRef ?? payload.outputRef ?? payload.preTrimRef ?? null);
  return {
    type: "ledger",
    kind,
    title: built.title,
    ...(built.detail ? { detail: cap(built.detail, DETAIL_CAP) } : {}),
    ...(payloadRef ? { payloadRef } : {}),
    seq: index,
  };
}

function buildTitleAndDetail(record, payload) {
  switch (record.kind) {
    case "handoff": {
      const next = payload?.nextSteps?.next ?? "?";
      const title = `Handoff #${payload.ordinal ?? "?"} - ${payload.status ?? "?"} -> ${next}`;
      // The row's detail is the WHOLE handoff, pretty-printed and capped: the
      // summary and the reasoning read first, and the fields a reviewer would
      // otherwise have to open the raw log for (failedApproaches, evidenceRefs,
      // blocker) are right there under them.
      const head = [
        typeof payload.summary === "string" ? payload.summary : "",
        payload?.nextSteps?.why ? `Next: ${next} - ${payload.nextSteps.why}` : "",
      ].filter(Boolean).join("\n\n");
      return { title, detail: [head, safeJson(payload)].filter(Boolean).join("\n\n") };
    }
    case "approval-requested": {
      const next = text(payload.next) || "the next step";
      const items = Array.isArray(payload.items) && payload.items.length
        ? "\n\nPlanned:\n" + payload.items.slice(0, 12).map((i) => `- ${text(i)}`).join("\n")
        : "";
      return {
        title: `Waiting for your go-ahead - next: ${next}`,
        detail: [text(payload.plan), items.trim()].filter(Boolean).join("\n\n") || null,
      };
    }
    case "delegation-dispatched": {
      const who = [payload.runtime, payload.model].filter(Boolean).join(" / ") || "a secondary runtime";
      return { title: `Delegation dispatched to ${who}`, detail: text(payload.task) };
    }
    case "delegation-returned": {
      const bits = [payload.ok === false ? "not ok" : "ok"];
      if (Number.isFinite(payload.usedTokens)) bits.push(`${payload.usedTokens} tokens`);
      if (Number.isFinite(payload.durationMs)) bits.push(`${Math.round(payload.durationMs / 1000)}s`);
      return { title: `Delegation returned (${bits.join(", ")})`, detail: text(payload.summary) };
    }
    case "delegation-failed":
      return {
        title: `Delegation failed - ${payload.code ?? "unknown"}`,
        detail: text(payload.message ?? payload.error),
      };
    case "card-state-changed": {
      const from = payload?.from?.list ?? payload?.from?.status ?? "?";
      const to = payload?.to?.list ?? payload?.to?.status ?? "?";
      const by = payload.by ? ` (by ${payload.by})` : "";
      return { title: `Card moved ${from} -> ${to}${by}`, detail: null };
    }
    case "card-materialized": {
      const where = payload.list ? ` in ${payload.list}` : "";
      const who = payload.decidedBy ? ` (decided by ${payload.decidedBy})` : "";
      return {
        title: `Card materialized${where}${who}: ${text(payload.title) || payload.cardId || "untitled"}`,
        detail: text(payload.reason),
      };
    }
    case "conversation-opened":
      return {
        title: `Conversation opened${payload.title ? `: ${text(payload.title)}` : ""}`,
        detail: payload.origin ? `Origin: ${text(payload.origin)}` : null,
      };
    case "escalation":
      return {
        title: `Escalated ${record.duty ?? "duty"}: ${payload.from ?? "?"} -> ${payload.to ?? "?"}`,
        detail: [payload.reason ? text(payload.reason) : "", payload.chosenBy ? `Chosen by: ${payload.chosenBy}` : ""]
          .filter(Boolean).join("\n") || null,
      };
    case "policy-rewrite":
      return {
        title: `Routing rewritten: ${payload.from ?? "?"} -> ${payload.to ?? "?"}`,
        detail: payload.reason ? text(payload.reason) : null,
      };
    case "summary-trimmed": {
      const dropped = Array.isArray(payload.dropped) ? payload.dropped : [];
      return {
        title: `Summary trimmed (${dropped.length} ${dropped.length === 1 ? "entry" : "entries"} dropped)`,
        detail: dropped.length ? dropped.map((d) => `- ${text(d)}`).join("\n") : null,
      };
    }
    default:
      return null;
  }
}

// ── field helpers ───────────────────────────────────────────────────────────

function recordTs(record) {
  const parsed = Date.parse(record?.ts ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function stretchIdOf(record, payload) {
  return label(payload?.stretchId) ?? label(record?.stretch) ?? null;
}

function dutyOf(record, payload) {
  return label(record?.duty) ?? label(payload?.duty) ?? null;
}

function label(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function cap(value, max) {
  const str = text(value);
  return str.length <= max ? str : `${str.slice(0, max)}\n... [truncated ${str.length - max} chars]`;
}

function safeJson(payload) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "";
  }
}

/** The renderer's `payloadRef` is an OPAQUE name it appends to the payload
 *  endpoint, so the store's `payloads/<name>` spelling loses its directory here.
 *  The serving layer accepts both spellings, so a ref that arrives either way
 *  still resolves. */
function normalizePayloadRef(ref) {
  const value = label(ref);
  if (!value) return null;
  const bare = value.startsWith("payloads/") ? value.slice("payloads/".length) : value;
  return /^[A-Za-z0-9._-]{1,200}$/.test(bare) && bare !== "." && bare !== ".." ? bare : null;
}

/** A stretch's attribution is the SAME bag the Turn Rail renders for a normal
 *  turn (route attribution), so a stretch badge and a turn badge cannot drift
 *  into two spellings of the same fact. `account: null` is deliberate: the
 *  launcher does not resolve an account per stretch, and an explicit null reads
 *  as "not reported" rather than being mistaken for a value. */
function attributionFromTarget(target) {
  const t = target && typeof target === "object" ? target : {};
  const out = { account: null };
  if (label(t.id)) out.route = label(t.id);
  if (label(t.runtime)) out.runtime = label(t.runtime);
  if (label(t.provider)) out.provider = label(t.provider);
  if (label(t.model)) out.model = label(t.model);
  if (label(t.effort)) out.effort = label(t.effort);
  return out;
}

function attributionFromEnded(payload) {
  const out = { account: null };
  if (label(payload?.model)) out.model = label(payload.model);
  if (label(payload?.effortApplied)) out.effort = label(payload.effortApplied);
  return out;
}
